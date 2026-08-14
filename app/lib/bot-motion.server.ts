import { InlineKeyboard, type Bot, type Context } from "grammy";
import { nanoid } from "nanoid";
import { supabase } from "./supabase.server";
import type { DbTrip } from "./db.server";
import {
  looksLikeMotion,
  motionFormat,
  parkedMotionIsFresh,
  pickStillForMotion,
  LIVE_PAIR_WINDOW_MS,
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
import { encodeAction, motionCode } from "./manage";
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
  id: string;
  storagePath: string;
  durationMs: number | null;
  coverHash: string | null;
  parkedAtMs: number;
}

/** Every motion this chat has waiting on this trip, oldest first. */
async function parkedMotions(chatId: number, tripId: string): Promise<ParkedMotion[]> {
  const { data, error } = await supabase()
    .from("pending_motions")
    .select("id, storage_path, duration_ms, cover_phash, created_at")
    .eq("chat_id", chatId)
    .eq("trip_id", tripId)
    .order("created_at", { ascending: true });
  // Not the same as nothing waiting. Swallowed, a missing table reads as "no
  // videos are waiting" everywhere at once — which is exactly how this shipped
  // and how it stayed invisible.
  if (error) throw new Error(`could not read the waiting Live Photo videos: ${error.message}`);

  return (data ?? []).map((row) => ({
    id: row.id,
    storagePath: row.storage_path,
    durationMs: row.duration_ms,
    coverHash: row.cover_phash,
    parkedAtMs: Date.parse(row.created_at),
  }));
}

/**
 * Park an already-uploaded video until the photo it belongs to turns up.
 *
 * Several can wait at once. Keying this by chat and overwriting looked
 * reasonable — one Live Photo at a time is how a person sends them — right up
 * until six edited photos went up and then six videos: each would have thrown
 * away the last, and the upload with it.
 */
async function parkMotion(
  chatId: number,
  tripId: string,
  motion: Omit<ParkedMotion, "id" | "parkedAtMs">,
): Promise<string> {
  const { data, error } = await supabase()
    .from("pending_motions")
    .insert({
      chat_id: chatId,
      trip_id: tripId,
      storage_path: motion.storagePath,
      duration_ms: motion.durationMs,
      cover_phash: motion.coverHash,
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`could not hold onto that video: ${error?.message ?? "no row came back"}`);
  }
  return data.id as string;
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
  // Only the recent ones. An older video is still waiting to be placed by hand
  // and must not be swept up by whatever photo happens to arrive next.
  const waiting = (await parkedMotions(chatId, tripId)).filter((m) =>
    parkedMotionIsFresh(m.parkedAtMs, Date.now()),
  );
  if (waiting.length === 0) return false;

  const parked = pickParkedFor(waiting, photoHash);
  if (!parked) return false;

  await supabase().from("pending_motions").delete().eq("id", parked.id);
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

/**
 * Which of the waiting motions is a recording of this photo.
 *
 * A fingerprint on both sides settles it, and settles it in the photo's favour
 * only if they actually look alike — that is what lets a Live Photo and an
 * ordinary photo be sent in either order without the ordinary one collecting
 * three seconds of somewhere else. With nothing to compare, the oldest waiting
 * motion is the best guess available, which is the same guess the order rule
 * makes.
 */
function pickParkedFor(waiting: ParkedMotion[], photoHash: string | null): ParkedMotion | null {
  if (photoHash) {
    const seen = waiting
      .filter((m) => m.coverHash)
      .map((m) => ({ motion: m, distance: hammingDistance(m.coverHash!, photoHash) }))
      .filter((m) => m.distance <= MOTION_MAX_DISTANCE)
      .sort((a, b) => a.distance - b.distance);
    if (seen.length > 0) return seen[0].motion;
  }
  // Every waiting motion knows what it is a recording of, and none of them is
  // this. Leave them be: their photos may still be uploading behind this one.
  if (waiting.every((m) => m.coverHash) && photoHash) return null;
  return waiting.find((m) => !m.coverHash) ?? null;
}

/**
 * How long a video with no photo is kept.
 *
 * Far longer than the window for pairing it with the next photo automatically,
 * and for a different reason: that window is about how confident a guess can
 * be, this one is about how long someone has to come back and say by hand which
 * photo it belongs to. A week is enough for a trip's worth of evenings.
 */
const MOTION_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Clear out motions nobody ever claimed, files and all. Called from the nightly
 * cron: a video whose photo never arrived is only found by a photo or by hand,
 * so without this it would sit in the bucket for the life of the project.
 */
export async function sweepParkedMotions(): Promise<number> {
  const cutoff = new Date(Date.now() - MOTION_KEEP_MS).toISOString();
  const { data } = await supabase()
    .from("pending_motions")
    .select("id, storage_path")
    .lt("created_at", cutoff);
  if (!data || data.length === 0) return 0;

  await supabase()
    .from("pending_motions")
    .delete()
    .in("id", data.map((row) => row.id));
  await supabase().storage.from("photos").remove(data.map((row) => row.storage_path));
  return data.length;
}

/** A waiting video, found by the short code its buttons carry. */
export async function parkedMotionByCode(
  chatId: number,
  tripId: string,
  code: string,
): Promise<ParkedMotion | null> {
  const waiting = await parkedMotions(chatId, tripId);
  return waiting.find((m) => motionCode(m.id) === code) ?? null;
}

/** How many videos are waiting to be placed by hand. */
export async function waitingMotions(chatId: number, tripId: string): Promise<ParkedMotion[]> {
  return parkedMotions(chatId, tripId);
}

/** A waiting video's file, for showing it in a message. */
export function motionUrl(storagePath: string): string {
  return supabase().storage.from("photos").getPublicUrl(storagePath).data.publicUrl;
}

/**
 * Hand a waiting video to the photo someone picked. Returns false if either has
 * gone in the meantime — a second tap on the same button, or the photo deleted
 * from another screen.
 *
 * A photo that already had motion loses it: the old file is removed once the
 * row points at the new one. That is deliberate rather than an error, because
 * the only way to correct a wrong pick is to pick again, and a correction that
 * left the mistake in the bucket would leak a file per attempt.
 */
/**
 * Take a video back off the photo it was put on, and stand it back in the
 * queue so it can be placed on the right one. Returns the waiting video's code.
 *
 * It is parked as though it had arrived five minutes ago, which is the age at
 * which the automatic rule stops considering it. That is not a trick to get a
 * flag for free: this video has already been placed once by that rule and the
 * rule got it wrong, so it having no claim on the next photo to arrive is
 * exactly right.
 */
export async function unpairMotion(
  chatId: number,
  tripId: string,
  mediaId: string,
): Promise<string | null> {
  const { data: photo } = await supabase()
    .from("media")
    .select("motion_path, motion_ms")
    .eq("id", mediaId)
    .maybeSingle();
  if (!photo?.motion_path) return null;

  const { data, error } = await supabase()
    .from("pending_motions")
    .insert({
      chat_id: chatId,
      trip_id: tripId,
      storage_path: photo.motion_path,
      duration_ms: photo.motion_ms,
      cover_phash: null,
      created_at: new Date(Date.now() - LIVE_PAIR_WINDOW_MS).toISOString(),
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`could not take that video off: ${error?.message ?? "no row came back"}`);
  }

  // Only once the video has somewhere else to be. The other order would drop it
  // off the photo and lose it if this failed.
  await supabase()
    .from("media")
    .update({ motion_path: null, motion_ms: null })
    .eq("id", mediaId);
  return data.id as string;
}

export async function attachMotionByHand(
  chatId: number,
  tripId: string,
  code: string,
  mediaId: string,
): Promise<boolean> {
  const parked = await parkedMotionByCode(chatId, tripId, code);
  if (!parked) return false;

  const { data: photo } = await supabase()
    .from("media")
    .select("motion_path")
    .eq("id", mediaId)
    .maybeSingle();
  if (!photo) return false;

  const { data: updated, error } = await supabase()
    .from("media")
    .update({ motion_path: parked.storagePath, motion_ms: parked.durationMs })
    .eq("id", mediaId)
    .select("id");
  if (error || (updated ?? []).length === 0) return false;

  await supabase().from("pending_motions").delete().eq("id", parked.id);
  // Only now, while nothing points at it any more.
  if (photo.motion_path && photo.motion_path !== parked.storagePath) {
    await supabase().storage.from("photos").remove([photo.motion_path]);
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

  // Order is a fallback for having *nothing to look at*, not a second opinion.
  // Letting it answer after a cover frame had failed to match anything put a
  // video from one day onto the newest photo of another — the two pictures 27
  // bits apart, which is to say nothing whatsoever in common. A cover frame
  // that matches nothing is not an absent answer, it is the answer "none of
  // these", and the video goes to the picker instead of to whichever photo
  // happened to be uploaded last.
  const still = coverHash ? seen : pickStillForMotion(sentAtMs, pool);

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
    let parkedId: string;
    try {
      parkedId = await parkMotion(ctx.chat!.id, trip.id, {
        storagePath: path,
        durationMs,
        coverHash,
      });
    } catch (err) {
      // The file is already in the bucket and nothing now points at it. Take it
      // back out and say so: a cheerful "held onto that motion" over a video
      // that was not held onto is the worst of the available answers.
      await store.remove([path]);
      await ctx.reply(
        `⚠️ I couldn't keep that video: ${err instanceof Error ? err.message : "unknown error"}\n\n` +
          `Nothing was stored. If this says the table is missing, supabase/schema.sql needs ` +
          `running again.`,
      );
      return;
    }
    // Which of the two situations this is matters to the person reading it:
    // nothing on the trip looking like the video is a dead end they should stop
    // repeating, whereas an empty trip is simply the photo not being here yet.
    const nothingLikeIt = coverHash && pool.some((c) => !c.hasMotion);
    // The button is the way out of the dead end: recognition has already failed
    // for this video, so telling someone to send the photo again is telling
    // them to repeat what did not work. Picking it is the answer.
    const keyboard =
      pool.length > 0
        ? new InlineKeyboard().text(
            "🎬 Pick the photo",
            encodeAction({ type: "motionHome", code: motionCode(parkedId) }),
          )
        : undefined;
    await ctx.reply(
      nothingLikeIt
        ? `🎬 Held onto that motion, but nothing on the trip looks like it — a crop or a ` +
            `straighten in an editor will do that. Pick the photo below, or send it again ` +
            `and I'll pair them.${caveat}`
        : `🎬 Held onto that motion — send the photo it belongs to and I'll put them ` +
            `together.${caveat}`,
      keyboard ? { reply_markup: keyboard } : undefined,
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

  // Worth distinguishing: "recognised" means the bot saw the photograph in the
  // video's own cover frame, which is the answer that can be trusted. The other
  // is a guess from the order things arrived in, and saying so lets a wrong one
  // be spotted rather than discovered weeks later on the page.
  const how = seen
    ? "🔍 Recognised the photo it belongs to"
    : "🎬 Live Photo — going by the order it arrived in, not by the picture";
  await ctx.reply(`${how} — that's now the motion behind the photo on day ${still.dayNumber}.${caveat}`);
}
