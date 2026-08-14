/**
 * Live Photos: a still with three seconds of motion behind it.
 *
 * An iPhone keeps a Live Photo as two files — the JPEG (or HEIC) everyone sees
 * and a short silent MOV beside it — and nothing in Telegram carries that pair
 * across as one thing. Whatever the traveller does, the bot receives two
 * unrelated updates: a photo, and a video that happens to be three seconds
 * long. Putting them back together is therefore guesswork, and this module is
 * where the guessing rules live, on their own and testable, because getting
 * them wrong in either direction is unpleasant: too eager and a real clip
 * disappears into the photo above it, too strict and the feature never fires.
 *
 * The rule we settled on is *order and closeness*, not file names. Telegram
 * strips the name off a compressed photo entirely, so `IMG_4711.MOV` has
 * nothing to match against in the usual case, and building the whole feature on
 * the one path that keeps names (sending as a file) would mean it works for
 * almost nobody. What is always true is that the two halves are sent together —
 * picked in the same album, or one straight after the other — so a short video
 * belongs to the nearest still that hasn't got one yet.
 *
 * Nothing here touches Telegram, Supabase or the clock: callers pass in what
 * they know and get a decision back.
 */

/**
 * The longest a video may be and still be taken for the motion half of a Live
 * Photo. Apple records 1.5 s either side of the shutter, so about three; the
 * headroom is for the older 2 s recordings and for what a re-encode does to the
 * reported duration. Anything longer is a clip someone meant to send.
 */
export const LIVE_MOTION_MAX_S = 6;

/**
 * How long a still stays open to being given motion.
 *
 * Generous because the two halves are sent by hand, one after the other, and a
 * phone on a mountain pass uploads a video far more slowly than a photo — but
 * not so generous that this morning's photo claims the clip sent at lunchtime.
 */
export const LIVE_PAIR_WINDOW_MS = 5 * 60 * 1000;

/** A video arriving in the chat, in the terms Telegram describes it. */
export interface IncomingMotion {
  /** Seconds, as Telegram reports them. Absent for a document — see `looksLikeMotion`. */
  durationS: number | null;
  fileName: string | null;
  mimeType: string | null;
  fileSize: number | null;
}

/**
 * A video sent as a *file* has no duration attached, so size stands in for it.
 * Three seconds of iPhone HEVC is a couple of megabytes; this is well clear of
 * that and still far under anything worth calling a clip.
 */
export const MOTION_DOCUMENT_MAX_BYTES = 12 * 1024 * 1024;

/** Whether this video is short enough to be the motion behind a photo. */
export function looksLikeMotion(motion: IncomingMotion): boolean {
  if (motion.durationS !== null) return motion.durationS > 0 && motion.durationS <= LIVE_MOTION_MAX_S;
  // No duration to go on: a file. Judge it by size instead.
  return (motion.fileSize ?? Infinity) <= MOTION_DOCUMENT_MAX_BYTES;
}

export interface MotionFormat {
  extension: string;
  contentType: string;
  /**
   * True for QuickTime, which iPhones hand over untouched when the video is
   * sent as a file. Safari plays it; Chrome and Firefox mostly will not,
   * because what is inside is HEVC. Worth storing anyway — half the family is
   * on iPhones — but worth saying so as well.
   */
  patchy: boolean;
}

/**
 * How to store an incoming video, or null for something that is not one.
 *
 * Telegram supplies a MIME type for a compressed video and usually for a file;
 * where it doesn't, the name decides.
 */
export function motionFormat(mimeType: string | null, fileName: string | null): MotionFormat | null {
  const mime = (mimeType ?? "").toLowerCase().trim();
  const name = (fileName ?? "").toLowerCase();
  const matches = (extensions: string[], ...mimes: string[]) =>
    mimes.includes(mime) || (mime === "" && extensions.some((e) => name.endsWith(e)));

  if (matches([".mp4", ".m4v"], "video/mp4", "video/x-m4v")) {
    return { extension: ".mp4", contentType: "video/mp4", patchy: false };
  }
  if (matches([".mov"], "video/quicktime")) {
    return { extension: ".mov", contentType: "video/quicktime", patchy: true };
  }
  return mime.startsWith("video/") ? { extension: ".mp4", contentType: mime, patchy: true } : null;
}

/** A photo already stored, as far as pairing is concerned. */
export interface MotionCandidate {
  id: string;
  dayNumber: number;
  /** Where the photo's files live, so the motion can be filed beside them. */
  storagePath: string;
  /** When the message carrying the photo was sent. */
  sentAtMs: number;
  hasMotion: boolean;
}

/**
 * Which stored photo this video is the motion of, if any: the *newest* still
 * inside the window that hasn't already been given motion.
 *
 * Newest rather than oldest, and the difference matters. A day's uploads are
 * mostly ordinary photos with the odd Live Photo among them, so reaching for
 * the oldest unpaired still would hand the motion to a plain photo sent four
 * minutes earlier and leave the Live Photo — sent seconds ago, which is the
 * whole reason we are here — a still. Sending the two halves back to back is
 * what a person does, so the last thing sent is what the video belongs to.
 *
 * "Hasn't already" then keeps several Live Photos in a row honest: each video
 * pairs with its own still and the next one has to look further back rather
 * than overwriting what the last one just did.
 */
export function pickStillForMotion(
  sentAtMs: number,
  candidates: MotionCandidate[],
): MotionCandidate | null {
  const open = candidates
    .filter((c) => !c.hasMotion)
    .filter((c) => sentAtMs - c.sentAtMs >= 0 && sentAtMs - c.sentAtMs <= LIVE_PAIR_WINDOW_MS)
    .sort((a, b) => b.sentAtMs - a.sentAtMs);
  return open[0] ?? null;
}

/**
 * Telegram delivers an album's items in the order they were picked, and on iOS
 * that can put the video before its still. A motion with nowhere to go is
 * therefore parked rather than refused, and the next photo through the door
 * takes it — as long as it is still fresh, by the same window as above.
 */
export function parkedMotionIsFresh(parkedAtMs: number, nowMs: number): boolean {
  return nowMs - parkedAtMs >= 0 && nowMs - parkedAtMs <= LIVE_PAIR_WINDOW_MS;
}
