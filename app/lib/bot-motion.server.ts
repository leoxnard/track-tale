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
import { downloadTelegramFile, TELEGRAM_DOWNLOAD_LIMIT } from "./bot-chrome.server";

/**
 * The motion half of a Live Photo, between Telegram and the photo it belongs
 * to.
 *
 * Which still a video belongs to is decided in `live-photo.ts`, which knows
 * nothing about anything; this module does the fetching, the storing and the
 * two ways round the pair can arrive. Videos exist on this trip only as the
 * three seconds behind a photograph — there is deliberately no such thing as a
 * standalone clip, because a page built around a map and a photo grid has
 * nowhere honest to put one, and adding half a video feature would be worse
 * than adding none.
 */

/** How many recent photos are considered as the still a video belongs to. */
const CANDIDATE_LIMIT = 25;

/** Where a video is filed: beside the still it belongs to, sharing its folder. */
function motionPathBeside(stillPath: string, extension: string): string {
  const dir = stillPath.includes("/") ? stillPath.slice(0, stillPath.lastIndexOf("/")) : "";
  const name = `${nanoid(8)}-live${extension}`;
  return dir ? `${dir}/${name}` : name;
}

/** The trip's recent photos, in the shape the pairing rules want them. */
async function motionCandidates(tripId: string): Promise<MotionCandidate[]> {
  const { data: days } = await supabase()
    .from("days")
    .select("id, day_number")
    .eq("trip_id", tripId);
  if (!days || days.length === 0) return [];
  const dayNumber = new Map(days.map((d) => [d.id, d.day_number]));

  const { data: photos } = await supabase()
    .from("media")
    .select("id, day_id, storage_path, telegram_date, motion_path")
    .in("day_id", [...dayNumber.keys()])
    .order("telegram_date", { ascending: false })
    .limit(CANDIDATE_LIMIT);

  return (photos ?? []).map((p) => ({
    id: p.id,
    dayNumber: dayNumber.get(p.day_id) ?? 0,
    storagePath: p.storage_path,
    sentAtMs: Date.parse(p.telegram_date),
    hasMotion: Boolean(p.motion_path),
  }));
}

/** Park an already-uploaded video until the photo it belongs to turns up. */
async function parkMotion(
  chatId: number,
  tripId: string,
  storagePath: string,
  durationMs: number | null,
): Promise<void> {
  // Whatever was waiting here is now stale — one Live Photo at a time, and the
  // old file would otherwise sit in the bucket with nothing naming it.
  const previous = await takeParkedMotion(chatId, tripId, { onlyIfFresh: false });
  if (previous) await supabase().storage.from("photos").remove([previous.storagePath]);

  await supabase()
    .from("pending_motions")
    .upsert(
      {
        chat_id: chatId,
        trip_id: tripId,
        storage_path: storagePath,
        duration_ms: durationMs,
        // Explicit, because an upsert over an existing row keeps the old
        // default and this one has to restart the clock.
        created_at: new Date().toISOString(),
      },
      { onConflict: "chat_id" },
    );
}

interface ParkedMotion {
  storagePath: string;
  durationMs: number | null;
}

/**
 * Take whatever motion this chat has waiting, clearing it either way. Stale
 * entries are dropped rather than honoured, so a video from before lunch does
 * not attach itself to the afternoon's first photo.
 */
async function takeParkedMotion(
  chatId: number,
  tripId: string,
  { onlyIfFresh = true }: { onlyIfFresh?: boolean } = {},
): Promise<ParkedMotion | null> {
  const { data } = await supabase()
    .from("pending_motions")
    .select("storage_path, duration_ms, trip_id, created_at")
    .eq("chat_id", chatId)
    .maybeSingle();
  if (!data) return null;

  await supabase().from("pending_motions").delete().eq("chat_id", chatId);

  const usable =
    !onlyIfFresh || (data.trip_id === tripId && parkedMotionIsFresh(Date.parse(data.created_at), Date.now()));
  if (!usable) {
    // Not ours to use, but ours to clean up.
    await supabase().storage.from("photos").remove([data.storage_path]);
    return null;
  }
  return { storagePath: data.storage_path, durationMs: data.duration_ms };
}

/**
 * Give a freshly stored photo the motion that arrived ahead of it, if any.
 * Returns whether it did, so the confirmation can say so.
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
): Promise<boolean> {
  const parked = await takeParkedMotion(chatId, tripId);
  if (!parked) return false;

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
}

/**
 * A video arriving in the chat. Either it is the motion behind a photo already
 * on the trip, or it is the motion behind one that hasn't arrived yet, or it is
 * a clip — and a clip gets an explanation rather than silence, because from the
 * traveller's side sending a video and having nothing happen is indisting-
 * uishable from the bot being broken.
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
        "photo and then the video it came with, one after the other.",
    );
    return;
  }
  if ((incoming.fileSize ?? 0) > TELEGRAM_DOWNLOAD_LIMIT) {
    await ctx.reply("That video is over 20 MB, which Telegram won't let me download.");
    return;
  }

  const sentAtMs = ctx.message!.date * 1000;
  const still = pickStillForMotion(sentAtMs, await motionCandidates(trip.id));

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
    await parkMotion(ctx.chat!.id, trip.id, path, durationMs);
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

  await ctx.reply(
    `🎬 Live Photo — that's now the motion behind the photo on day ${still.dayNumber}.${caveat}`,
  );
}
