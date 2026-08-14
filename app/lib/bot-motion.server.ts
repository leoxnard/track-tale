import type { Bot, Context } from "grammy";
import { nanoid } from "nanoid";
import { supabase } from "./supabase.server";
import type { DbTrip } from "./db.server";
import {
  looksLikeMotion,
  motionFormat,
  parkedMotionIsFresh,
  pickStillForMotion,
  type IncomingMotion,
  type MotionCandidate,
} from "./live-photo";
import {
  findTwin,
  hammingDistance,
  perceptualHash,
  MOTION_MAX_DISTANCE,
  MOTION_MIN_MARGIN,
} from "./phash";
import { hashPhotos } from "./photo-index.server";
import { downloadTelegramFile, TELEGRAM_DOWNLOAD_LIMIT } from "./bot-chrome.server";

/**
 * The motion half of a Live Photo, and which photograph it belongs to.
 *
 * Telegram carries the two halves across as two unrelated updates, so the
 * pairing has to be worked out at this end. It is worked out twice, in order of
 * how much it can be trusted:
 *
 * 1. **By what the video looks like.** Telegram attaches a cover frame to every
 *    video it forwards, and the cover frame of a Live Photo's three seconds is
 *    the photograph itself, give or take the second and a half either side of
 *    the shutter. Fingerprinting that frame with the same difference hash that
 *    already recognises an edited re-upload (`phash.ts`) answers the question
 *    outright — and answers it for the whole trip, so the video can be sent an
 *    hour later, or tomorrow, and still find its still.
 * 2. **By order and closeness**, in `live-photo.ts`, when there is no cover
 *    frame to go on or nothing on the trip looks like it.
 *
 * Videos exist here only as the three seconds behind a photograph. There is
 * deliberately no such thing as a standalone clip: a page built around a map
 * and a photo grid has nowhere honest to put one, and half a video feature
 * would be worse than none.
 */

/**
 * How far back the look-alike search reaches. The same ceiling as the twin
 * index, and for the same reason: beyond this, a first match spends longer
 * fingerprinting the trip than anyone will wait on a webhook.
 */
const CANDIDATE_LIMIT = 200;

/** Where a video is filed: beside the still it belongs to, sharing its folder. */
function motionPathBeside(stillPath: string, extension: string): string {
  const dir = stillPath.includes("/") ? stillPath.slice(0, stillPath.lastIndexOf("/")) : "";
  const name = `${nanoid(8)}-live${extension}`;
  return dir ? `${dir}/${name}` : name;
}

interface Candidate extends MotionCandidate {
  phash: string | null;
  thumbPath: string | null;
}

/** The trip's photos, in the shape both pairing rules want them. */
async function candidates(tripId: string): Promise<Candidate[]> {
  const { data: days } = await supabase().from("days").select("id, day_number").eq("trip_id", tripId);
  if (!days || days.length === 0) return [];
  const dayNumber = new Map(days.map((d) => [d.id, d.day_number]));

  const { data: photos } = await supabase()
    .from("media")
    .select("id, day_id, storage_path, thumb_path, phash, telegram_date, motion_path")
    .in("day_id", [...dayNumber.keys()])
    .order("telegram_date", { ascending: false })
    .limit(CANDIDATE_LIMIT);

  return (photos ?? []).map((p) => ({
    id: p.id,
    dayNumber: dayNumber.get(p.day_id) ?? 0,
    storagePath: p.storage_path,
    thumbPath: p.thumb_path,
    phash: p.phash,
    sentAtMs: Date.parse(p.telegram_date),
    hasMotion: Boolean(p.motion_path),
  }));
}

/**
 * The photo this video is a recording of, by sight. Only photos still without
 * motion are considered — a still that already has its three seconds is not
 * looking for more, and leaving it in would let a second Live Photo of the same
 * view take the answer away from the one that needs it.
 */
async function pickStillByLook(
  coverHash: string,
  pool: Candidate[],
): Promise<Candidate | null> {
  const open = pool.filter((c) => !c.hasMotion);
  if (open.length === 0) return null;

  const hashed = await hashPhotos(
    open.map((c) => ({
      id: c.id,
      phash: c.phash,
      thumb_path: c.thumbPath,
      storage_path: c.storagePath,
    })),
  );
  const match = findTwin(coverHash, hashed, {
    maxDistance: MOTION_MAX_DISTANCE,
    minMargin: MOTION_MIN_MARGIN,
  });
  return match ? (open.find((c) => c.id === match.id) ?? null) : null;
}

/** The cover frame Telegram attaches to a video, fingerprinted. */
async function coverHashOf(bot: Bot, thumbFileId: string | null): Promise<string | null> {
  if (!thumbFileId) return null;
  try {
    return await perceptualHash(await downloadTelegramFile(bot, thumbFileId));
  } catch {
    // No cover frame is not a failure; it only means falling back to order.
    return null;
  }
}

interface ParkedMotion {
  storagePath: string;
  durationMs: number | null;
  coverHash: string | null;
}

/** Whatever motion this chat has waiting, or null. Does not clear it. */
async function peekParkedMotion(chatId: number, tripId: string): Promise<ParkedMotion | null> {
  const { data } = await supabase()
    .from("pending_motions")
    .select("storage_path, duration_ms, cover_phash, trip_id, created_at")
    .eq("chat_id", chatId)
    .maybeSingle();
  if (!data) return null;

  if (data.trip_id !== tripId || !parkedMotionIsFresh(Date.parse(data.created_at), Date.now())) {
    // Stale, or left over from another trip: not ours to use, but ours to
    // clean up rather than leave in the bucket with nothing naming it.
    await discardParkedMotion(chatId, data.storage_path);
    return null;
  }
  return {
    storagePath: data.storage_path,
    durationMs: data.duration_ms,
    coverHash: data.cover_phash,
  };
}

async function discardParkedMotion(chatId: number, storagePath: string): Promise<void> {
  await supabase().from("pending_motions").delete().eq("chat_id", chatId);
  await supabase().storage.from("photos").remove([storagePath]);
}

/** Park an already-uploaded video until the photo it belongs to turns up. */
async function parkMotion(
  chatId: number,
  tripId: string,
  motion: ParkedMotion,
): Promise<void> {
  // One at a time: whatever was waiting here has been superseded, and its file
  // would otherwise sit in the bucket unreferenced.
  const { data: previous } = await supabase()
    .from("pending_motions")
    .select("storage_path")
    .eq("chat_id", chatId)
    .maybeSingle();
  if (previous) await supabase().storage.from("photos").remove([previous.storage_path]);

  await supabase()
    .from("pending_motions")
    .upsert(
      {
        chat_id: chatId,
        trip_id: tripId,
        storage_path: motion.storagePath,
        duration_ms: motion.durationMs,
        cover_phash: motion.coverHash,
        // Explicit, because an upsert over an existing row keeps the old
        // default and this one has to restart the clock.
        created_at: new Date().toISOString(),
      },
      { onConflict: "chat_id" },
    );
}

/**
 * Give a freshly stored photo the motion that arrived ahead of it, if that
 * motion is a recording of *this* photo. Returns whether it did.
 *
 * Where both fingerprints exist they decide it, which is what lets a Live Photo
 * and an ordinary photo be sent in either order without the ordinary one
 * collecting three seconds of somewhere else. Where the video came without a
 * cover frame there is nothing to compare, and the next photo through the door
 * is the best guess available — the same guess the order rule makes.
 *
 * The parked file keeps the name it was uploaded under rather than being copied
 * into the day's folder: a second round trip through 2 MB of video to make a
 * path prettier is not worth the serverless seconds, and the row is what says
 * where the file belongs.
 */
export async function attachParkedMotion(
  chatId: number,
  tripId: string,
  mediaId: string,
  photoHash: string | null,
): Promise<boolean> {
  const parked = await peekParkedMotion(chatId, tripId);
  if (!parked) return false;

  if (parked.coverHash && photoHash && hammingDistance(parked.coverHash, photoHash) > MOTION_MAX_DISTANCE) {
    // A recording of something else. Leave it parked: the photo it belongs to
    // may still be uploading behind this one.
    return false;
  }

  await supabase().from("pending_motions").delete().eq("chat_id", chatId);
  const { error } = await supabase()
    .from("media")
    .update({ motion_path: parked.storagePath, motion_ms: parked.durationMs })
    .eq("id", mediaId);
  if (error) {
    await supabase().storage.from("photos").remove([parked.storagePath]);
    return false;
  }
  return true;
}

export interface IncomingVideo extends IncomingMotion {
  fileId: string;
  /** Telegram's cover frame, which is what the look-alike match runs on. */
  thumbFileId: string | null;
}

/**
 * A video arriving in the chat. Either it is the motion behind a photo on the
 * trip, or behind one that hasn't arrived yet, or it is a clip — and a clip
 * gets an explanation rather than silence, because from the traveller's side
 * sending a video and having nothing happen is indistinguishable from the bot
 * being broken.
 */
export async function saveMotion(
  ctx: Context,
  bot: Bot,
  trip: DbTrip,
  incoming: IncomingVideo,
): Promise<void> {
  const format = motionFormat(incoming.mimeType, incoming.fileName);
  if (!format) return;

  if (!looksLikeMotion(incoming)) {
    await ctx.reply(
      "That's a video rather than the three seconds behind a Live Photo, and the trip page " +
        "has nowhere to show a clip. Send a still instead — or, for a Live Photo, send the " +
        "photo and the video it came with, in either order.",
    );
    return;
  }
  if ((incoming.fileSize ?? 0) > TELEGRAM_DOWNLOAD_LIMIT) {
    await ctx.reply("That video is over 20 MB, which Telegram won't let me download.");
    return;
  }

  const sentAtMs = ctx.message!.date * 1000;
  const pool = await candidates(trip.id);
  const coverHash = await coverHashOf(bot, incoming.thumbFileId);

  const seen = coverHash ? await pickStillByLook(coverHash, pool) : null;
  const still = seen ?? pickStillForMotion(sentAtMs, pool);

  const bytes = await downloadTelegramFile(bot, incoming.fileId);
  const store = supabase().storage.from("photos");
  const durationMs = incoming.durationS !== null ? Math.round(incoming.durationS * 1000) : null;

  // No still to file it beside yet, so keep it out of the days' folders
  // entirely rather than guessing at one it may never join.
  const path = still
    ? motionPathBeside(still.storagePath, format.extension)
    : `${trip.id}/motion/${nanoid(8)}-live${format.extension}`;

  const up = await store.upload(path, bytes, { contentType: format.contentType });
  if (up.error) {
    await ctx.reply(`⚠️ Live Photo upload failed: ${up.error.message}`);
    return;
  }

  // QuickTime out of an iPhone is HEVC, which only Safari plays. Storing it is
  // still the right call — half the family is on an iPhone and gets the motion
  // — but the rest would see a still and wonder, so say it once.
  const caveat = format.patchy
    ? "\n\n⚠️ Sent as a file, so it's QuickTime: iPhones and Macs will play it, other browsers " +
      "may show only the still. Sending the video the normal compressed way avoids that."
    : "";

  if (!still) {
    await parkMotion(ctx.chat!.id, trip.id, { storagePath: path, durationMs, coverHash });
    await ctx.reply(
      `🎬 Held onto that motion — send the photo it belongs to and I'll put them together.${caveat}`,
    );
    return;
  }

  const { error } = await supabase()
    .from("media")
    .update({ motion_path: path, motion_ms: durationMs })
    .eq("id", still.id);
  if (error) {
    await store.remove([path]);
    await ctx.reply(`⚠️ Live Photo upload failed: ${error.message}`);
    return;
  }

  // Worth distinguishing: "recognised" means the pairing survives sending the
  // video days later, and someone who knows that will use it.
  const how = seen ? "🔍 Recognised the photo it belongs to" : "🎬 Live Photo";
  await ctx.reply(`${how} — that's now the motion behind the photo on day ${still.dayNumber}.${caveat}`);
}
