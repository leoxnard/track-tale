import type { Bot, Context } from "grammy";
import { nanoid } from "nanoid";
import { supabase } from "./supabase.server";
import type { DbTrip } from "./db.server";
import { matchPhotoToDay } from "./photo-match";
import { readExif, type ExifData } from "./exif";
import type { ImageDocument } from "./photo-file";
import { compressForWeb, COMPRESS_ABOVE_BYTES } from "./image.server";
import { findTwin, perceptualHash, type HashedPhoto } from "./phash";
import { fromGeoJson, type TrackGeoJson } from "./track";
import { renderOgCard } from "./og.server";
import {
  clearReplacement,
  pendingReplacement,
  replacePhoto,
  type ReplacementFiles,
} from "./media-replace.server";
import {
  downloadTelegramFile,
  recordAction,
  sendView,
  undoKeyboard,
  TELEGRAM_DOWNLOAD_LIMIT,
} from "./bot-chrome.server";
import { attachParkedMotion } from "./bot-motion.server";
import { replaceDayView } from "./manage.server";
import { requireDay, requireTrip } from "./bot-access.server";

/**
 * Everything that happens to a photograph between Telegram and the trip page:
 * where it belongs on the map, whether it is a shot the trip already has, and
 * what gets stored for it.
 */

type PhotoLocation = { lat: number; lng: number; source: "exif" | "track" };

/**
 * Places a photo on the map. A camera's own GPS fix is exact and always wins;
 * otherwise we fall back to matching a timestamp against the day's track,
 * preferring the EXIF capture time over the moment the message was sent.
 */
export async function locatePhoto(
  dayId: string,
  exif: ExifData,
  sentAtMs: number,
): Promise<PhotoLocation | null> {
  if (exif.lat !== undefined && exif.lng !== undefined) {
    return { lat: exif.lat, lng: exif.lng, source: "exif" };
  }
  const { data: segments } = await supabase()
    .from("track_segments")
    .select("geojson")
    .eq("day_id", dayId);
  const tracks = (segments ?? []).map((s) => fromGeoJson(s.geojson as TrackGeoJson));
  const hit = matchPhotoToDay(exif.takenAtMs ?? sentAtMs, tracks);
  return hit ? { ...hit, source: "track" } : null;
}

/**
 * A track often arrives after the photos it belongs to — someone shoots all
 * day and uploads the ride in the evening. Those photos were saved with no
 * position, so give them one now. Only untouched rows are considered, which
 * leaves an exact EXIF fix alone.
 */
export async function backfillPhotoLocations(dayId: string): Promise<number> {
  const { data: pending } = await supabase()
    .from("media")
    .select("id, telegram_date, taken_at")
    .eq("day_id", dayId)
    .is("matched_lat", null);
  if (!pending || pending.length === 0) return 0;

  const { data: segments } = await supabase()
    .from("track_segments")
    .select("geojson")
    .eq("day_id", dayId);
  const tracks = (segments ?? []).map((s) => fromGeoJson(s.geojson as TrackGeoJson));
  if (tracks.length === 0) return 0;

  let filled = 0;
  for (const photo of pending) {
    const at = Date.parse(photo.taken_at ?? photo.telegram_date);
    if (Number.isNaN(at)) continue;
    const hit = matchPhotoToDay(at, tracks);
    if (!hit) continue;
    const { error } = await supabase()
      .from("media")
      .update({ matched_lat: hit.lat, matched_lng: hit.lng, location_source: "track" })
      .eq("id", photo.id);
    if (!error) filled++;
  }
  return filled;
}

/** Beyond this a first auto-match would spend longer indexing than anyone will wait. */
const TWIN_INDEX_LIMIT = 200;

/**
 * Every photo on the trip with a fingerprint, computing the missing ones as it
 * goes. Hashes are read off the stored thumbnail — 20 kB rather than a whole
 * picture, and a difference hash gives the same answer either way.
 */
export async function hashedTripPhotos(tripId: string): Promise<HashedPhoto[]> {
  const { data: days } = await supabase().from("days").select("id").eq("trip_id", tripId);
  const dayIds = (days ?? []).map((d) => d.id);
  if (dayIds.length === 0) return [];

  const { data: photos } = await supabase()
    .from("media")
    .select("id, phash, thumb_path, storage_path")
    .in("day_id", dayIds)
    .limit(TWIN_INDEX_LIMIT);
  if (!photos) return [];

  const store = supabase().storage.from("photos");
  const hashed: HashedPhoto[] = [];
  for (const photo of photos) {
    if (photo.phash) {
      hashed.push({ id: photo.id, hash: photo.phash });
      continue;
    }
    try {
      const { data: blob } = await store.download(photo.thumb_path ?? photo.storage_path);
      if (!blob) continue;
      const hash = await perceptualHash(await blob.arrayBuffer());
      // Keep it, so the trip only pays this once per photo.
      await supabase().from("media").update({ phash: hash }).eq("id", photo.id);
      hashed.push({ id: photo.id, hash });
    } catch {
      // A photo we cannot read simply isn't a candidate.
    }
  }
  return hashed;
}

interface TwinPhoto {
  mediaId: string;
  dayNumber: number;
  caption: string | null;
  distance: number;
}

/**
 * The photo already on the trip that this file is an edited version of, if
 * there is one beyond doubt.
 */
export async function findEditedOriginal(tripId: string, hash: string): Promise<TwinPhoto | null> {
  const match = findTwin(hash, await hashedTripPhotos(tripId));
  if (!match) return null;

  const { data: row } = await supabase()
    .from("media")
    .select("id, caption, days(day_number)")
    .eq("id", match.id)
    .maybeSingle();
  if (!row) return null;

  const day = (row as unknown as { days: { day_number: number } | null }).days;
  if (!day) return null;
  return {
    mediaId: match.id,
    dayNumber: day.day_number,
    caption: row.caption,
    distance: match.distance,
  };
}

/**
 * Writes a camera's own fix onto an existing photo. Returns whether it did.
 * An exact fix beats both an empty position and one inferred off the track, so
 * this is the one case where a replacement is allowed to move a pin.
 */
export async function applyExifLocation(mediaId: string, exif: ExifData): Promise<boolean> {
  if (exif.lat === undefined || exif.lng === undefined) return false;
  const { error } = await supabase()
    .from("media")
    .update({
      matched_lat: exif.lat,
      matched_lng: exif.lng,
      location_source: "exif",
      ...(exif.takenAtMs ? { taken_at: new Date(exif.takenAtMs).toISOString() } : {}),
    })
    .eq("id", mediaId);
  return !error;
}

interface IncomingPhoto extends ImageDocument {
  fullFileId: string;
  thumbFileId: string | null;
  /** Already downloaded by the caller — a 20 MB file is not worth fetching twice. */
  bytes?: ArrayBuffer;
}

export async function savePhoto(
  ctx: Context,
  bot: Bot,
  trip: DbTrip,
  day: { id: string; day_number: number },
  incoming: IncomingPhoto,
) {
  const id = nanoid(8);
  const base = `${trip.id}/day-${day.day_number}/${id}`;
  const store = supabase().storage.from("photos");

  const fullBuf = incoming.bytes ?? (await downloadTelegramFile(bot, incoming.fullFileId));
  // Read the metadata off the original, before anything re-encodes it away.
  const exif = incoming.keepsExif ? readExif(fullBuf) : {};

  // Fingerprint the picture so a later edited export can find its way back to
  // this row instead of landing beside it.
  const phash = await perceptualHash(fullBuf).catch(() => null);

  let fullPath: string;
  let thumbPath: string | null = null;
  if (fullBuf.byteLength > COMPRESS_ABOVE_BYTES) {
    // A camera original is far more picture than a browser needs. Store a
    // screen-sized copy and make our own thumbnail, which beats the 320 px one
    // Telegram attaches to a document.
    const web = await compressForWeb(fullBuf);
    fullPath = `${base}.jpg`;
    const up = await store.upload(fullPath, web.display, { contentType: "image/jpeg" });
    if (up.error) throw up.error;
    thumbPath = `${base}-thumb.jpg`;
    const upThumb = await store.upload(thumbPath, web.thumb, { contentType: "image/jpeg" });
    if (upThumb.error) thumbPath = null;
  } else {
    fullPath = `${base}${incoming.extension}`;
    const up = await store.upload(fullPath, fullBuf, { contentType: incoming.contentType });
    if (up.error) throw up.error;

    if (incoming.thumbFileId && incoming.thumbFileId !== incoming.fullFileId) {
      const thumbBuf = await downloadTelegramFile(bot, incoming.thumbFileId);
      thumbPath = `${base}-thumb.jpg`;
      const upThumb = await store.upload(thumbPath, thumbBuf, { contentType: "image/jpeg" });
      if (upThumb.error) thumbPath = null;
    }
  }

  const sentAtMs = ctx.message!.date * 1000;
  const located = await locatePhoto(day.id, exif, sentAtMs);

  const { senderId, senderName } = ctx.state;
  const { data: inserted, error } = await supabase()
    .from("media")
    .insert({
      day_id: day.id,
      storage_path: fullPath,
      thumb_path: thumbPath,
      caption: ctx.message!.caption ?? null,
      telegram_date: new Date(sentAtMs).toISOString(),
      taken_at: exif.takenAtMs ? new Date(exif.takenAtMs).toISOString() : null,
      matched_lat: located?.lat ?? null,
      matched_lng: located?.lng ?? null,
      location_source: located?.source ?? null,
      phash,
      author_telegram_id: senderId,
      author_name: senderName,
    })
    .select("id")
    .single();
  if (error) throw error;

  // The motion half of a Live Photo can arrive first — Telegram delivers an
  // album in the order its items were picked. If one is waiting, this is the
  // still it was waiting for.
  const live = await attachParkedMotion(ctx.chat!.id, trip.id, inserted.id).catch(() => false);

  const where =
    located?.source === "exif"
      ? " and pinned where it was taken"
      : located
        ? " and pinned on the map"
        : "";
  const sent = await ctx
    .reply(`${live ? "🎬" : "📸"} Added to day ${day.day_number}${where}${live ? ", with its motion" : ""}.`, {
      reply_markup: undoKeyboard("media", inserted.id, day.day_number),
    })
    .catch(() => undefined);
  await recordAction(ctx, sent, "media", inserted.id);
}

/**
 * Puts new bytes behind the photo a `/replace` button picked, whether they
 * arrived compressed or as a file. The day never changes — a replacement is
 * the same picture, edited, not a new one.
 *
 * The pin does change in one direction: a replacement sent as a file can carry
 * the GPS fix the compressed original never had, and refusing to use it would
 * mean re-uploading a whole day's Lightroom exports and still having nothing on
 * the map. An exact fix therefore fills in or upgrades the position; a
 * replacement without one leaves whatever was there alone.
 */
export async function swapPendingPhoto(
  ctx: Context,
  trip: DbTrip,
  pending: { mediaId: string; dayNumber: number },
  files: ReplacementFiles,
  exif: ExifData = {},
  /** Whether a person picked this photo or the bot recognised it. */
  how: "picked" | "recognised" = "picked",
) {
  try {
    const swapped = await replacePhoto(pending.mediaId, files);
    await clearReplacement(ctx.chat!.id);

    if (!swapped) {
      await ctx.reply(
        `⚠️ That photo was deleted while I was waiting for the new one, so I left ` +
          `this picture out rather than putting it somewhere you didn't ask for.\n\n` +
          `/replace starts again.`,
      );
      return;
    }

    const pinned = await applyExifLocation(pending.mediaId, exif);

    // A share card built from a photo is now built from the old one.
    await renderOgCard(trip.id).catch(() => {});

    // Straight back to the day's photos: swapping one is rarely the whole job —
    // a filter run over a trip means doing this a dozen times, and the next one
    // should be one tap away rather than another /replace.
    const view = await replaceDayView(trip, pending.dayNumber, 0);
    const swap =
      how === "recognised"
        ? `🔍 Recognised as a photo already on *day ${pending.dayNumber}* and swapped in`
        : `🔄 Photo swapped on day ${pending.dayNumber}`;
    const headline = pinned ? `${swap} — 📍 pinned where it was taken.` : `${swap}.`;
    await sendView(ctx, { ...view, text: `${headline}\n\n${view.text}` });
  } catch (err) {
    await clearReplacement(ctx.chat!.id);
    await ctx.reply(
      `⚠️ Swapping that photo failed: ${err instanceof Error ? err.message : "unknown error"}\n\n` +
        `The old picture is untouched. /replace starts again.`,
    );
  }
}

/** Photos sent as files keep their EXIF, which is the whole point of this path. */
export async function savePhotoDocument(
  ctx: Context,
  bot: Bot,
  doc: { file_id: string; file_size?: number; thumbnail?: { file_id: string } },
  image: ImageDocument,
) {
  const trip = await requireTrip(ctx);
  if (!trip) return;

  if ((doc.file_size ?? 0) > TELEGRAM_DOWNLOAD_LIMIT) {
    await ctx.reply(
      "That photo is over 20 MB, which Telegram won't let me download. " +
        "Export it a little smaller and send it again.",
    );
    return;
  }

  const pending = await pendingReplacement(ctx.chat!.id);

  // Editing a trip's photos means sending a lot of them back. Rather than
  // walking the /replace menu each time, recognise the picture: an export of a
  // shot already on the trip goes back where that shot lives, on its own day,
  // keeping its caption and its place. Only files get this — a compressed
  // re-send is more likely a second look at the same view than an edit of it.
  let twin: TwinPhoto | null = null;
  let phash: string | null = null;
  const original = await downloadTelegramFile(bot, doc.file_id);
  const exif = image.keepsExif ? readExif(original) : {};

  if (!pending) {
    phash = await perceptualHash(original).catch(() => null);
    if (phash) twin = await findEditedOriginal(trip.id, phash);
  }

  const target = pending ?? (twin ? { mediaId: twin.mediaId, dayNumber: twin.dayNumber } : null);
  if (target) {
    const caption = ctx.message?.caption ?? null;
    const files: ReplacementFiles =
      original.byteLength > COMPRESS_ABOVE_BYTES
        ? await (async () => {
            const web = await compressForWeb(original);
            return { full: web.display, thumb: web.thumb, caption, phash };
          })()
        : {
            full: original,
            thumb: doc.thumbnail ? await downloadTelegramFile(bot, doc.thumbnail.file_id) : null,
            caption,
            format: { extension: image.extension, contentType: image.contentType },
            phash,
          };
    await swapPendingPhoto(ctx, trip, target, files, exif, pending ? "picked" : "recognised");
    return;
  }

  const day = await requireDay(ctx, trip);
  if (!day) return;

  try {
    await savePhoto(ctx, bot, trip, day, {
      fullFileId: doc.file_id,
      // Telegram generates a preview for image documents; reuse it for the grid.
      thumbFileId: doc.thumbnail?.file_id ?? null,
      bytes: original,
      ...image,
    });
  } catch (err) {
    await ctx.reply(`⚠️ Photo upload failed: ${err instanceof Error ? err.message : "unknown error"}`);
  }
}
