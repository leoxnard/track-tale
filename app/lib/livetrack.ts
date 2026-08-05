import type { TrackPoint } from "./track";

/**
 * Reading a Garmin LiveTrack session out of its own page.
 *
 * There is a REST endpoint behind the page — /api/sessions/{id}/track-points/
 * common — but it answers 403 to everything, including calls made from inside
 * the LiveTrack page itself. What does work is that the page is server-rendered
 * with the whole session embedded in its React payload, so that is what this
 * reads.
 *
 * That makes it scraping, and more brittle than the Komoot ingestion: a
 * framework upgrade on Garmin's side changes the payload and this stops
 * working. Every caller must treat null as normal and carry on without it.
 */

/**
 * When a finished session stops being worth re-checking.
 *
 * {@link COMPLETE_AFTER_MS} is deliberately short so the banner agrees with
 * Garmin's, which means a tunnel or a pass trips it. That is harmless while
 * nothing is written down — the next page load after the signal returns shows
 * the ride as live again. Recording the session as over is not reversible in
 * the same way, so it waits until no plausible gap in coverage is left.
 */
const SETTLED_AFTER_MS = 30 * 60 * 1000;

/**
 * True once a session has been over long enough that it will not come back to
 * life, so the stored link can be dropped and the page can stop fetching it.
 */
export function isSettled(session: LiveSession, now = Date.now()): boolean {
  const endMs = session.endedAt ? Date.parse(session.endedAt) : NaN;
  return Number.isFinite(endMs) && now - endMs > SETTLED_AFTER_MS;
}

/**
 * Whether an incoming LiveTrack link should be ignored in favour of the one
 * already stored.
 *
 * Garmin opens a session every time the device wakes, and most of them die
 * seconds later without ever reporting a position. One of those must not be
 * allowed to replace a ride that is genuinely in progress.
 *
 * The stored session only earns that protection while it is still running. A
 * finished one keeps its points for good, so testing for points alone would let
 * this morning's ride block every session for the rest of the day.
 */
export function keepsStoredSession(
  stored: LiveSession | null,
  incoming: LiveSession | null,
): boolean {
  // Nothing stored, unreadable, finished, or never got going: no claim.
  if (!stored || stored.complete || stored.points.length === 0) return false;
  // Could not read the incoming one, so we cannot say it is a dud: let it in.
  if (!incoming) return false;
  return incoming.points.length === 0;
}

export interface LivePoint extends TrackPoint {
  /** Metres from the start of the session, as Garmin counts them. */
  distanceM: number;
  moving: boolean;
}

/**
 * How long the session's own `end` may lag before we call it over.
 *
 * Garmin's page shows a "Session Complete" banner, but it renders that in the
 * browser from a translation bundle — the server-rendered HTML never contains
 * the words, so there is nothing to match on. What is in the payload is the
 * session's `end`, which advances continuously while the session is alive and
 * freezes the instant it finishes. So a stale `end` is the signal.
 *
 * Two minutes because that is roughly where Garmin's own banner flips: a
 * finished session was already showing "Session Complete" at 105 seconds. It
 * sits far above the ten-second reporting cadence of a live session, so an
 * active ride is never mistaken for a finished one.
 *
 * A longer window was tempting, to ride out a tunnel or a pass without the
 * banner dropping. It is the wrong call: Garmin drops its own banner in that
 * situation, and the point of this is to agree with the page the link opens.
 * Nothing polls, so each page load simply reflects what is true then — the
 * banner comes back by itself once the signal does.
 */
const COMPLETE_AFTER_MS = 2 * 60 * 1000;

export interface LiveSession {
  name: string | null;
  activityType: string | null;
  /** ISO timestamps from Garmin; `end` freezes when the session finishes. */
  startedAt: string | null;
  endedAt: string | null;
  /** The ride is over: show none of this as live. */
  complete: boolean;
  points: LivePoint[];
  distanceM: number;
  durationS: number;
  /** Where the traveller is right now — the last point Garmin has. */
  current: LivePoint | null;
  /** Timestamp of that last point, for showing how fresh the position is. */
  updatedAt: string | null;
}

/** One point as Garmin serialises it. Everything past position is optional. */
interface RawPoint {
  dateTime?: string;
  position?: { lat?: number; lon?: number };
  altitude?: number;
  totalDistanceMeters?: number;
  totalDurationSecs?: number;
  pointStatus?: string;
}

/**
 * The page ships its data as a series of `self.__next_f.push([1,"…"])` calls
 * whose payloads are JS string literals that concatenate into one blob.
 */
function extractFlightPayload(html: string): string {
  const pushes = html.matchAll(/self\.__next_f\.push\(\[1\s*,\s*("(?:[^"\\]|\\.)*")\]\)/g);
  let out = "";
  for (const push of pushes) {
    try {
      out += JSON.parse(push[1]) as string;
    } catch {
      // A chunk we cannot unescape is not worth failing the whole parse over.
    }
  }
  return out;
}

/**
 * Slice out the JSON array that starts at `start` by balancing brackets.
 *
 * Written by hand because the array sits inside a much larger blob that is not
 * itself valid JSON. String literals are skipped so a bracket inside a value
 * cannot end the scan early.
 */
function sliceArrayAt(blob: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < blob.length; i++) {
    const c = blob[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return blob.slice(start, i + 1);
  }
  return null;
}

/**
 * Every array stored under `"<key>":[`, in the order they appear.
 *
 * Garmin fetches the track as a react-query *infinite* query, so the payload
 * holds `{"pages":[{"trackPoints":[…]},{"trackPoints":[…]},…]}` — one array per
 * page, not one array. Reading only the first is why a long ride used to show
 * as a stub of its opening minutes and then stop.
 */
function sliceArrays(blob: string, key: string): string[] {
  const needle = `"${key}":[`;
  const out: string[] = [];
  let at = blob.indexOf(needle);
  while (at !== -1) {
    const start = at + needle.length - 1;
    const slice = sliceArrayAt(blob, start);
    if (slice === null) break;
    out.push(slice);
    at = blob.indexOf(needle, start + slice.length);
  }
  return out;
}

function sliceString(blob: string, key: string): string | null {
  const match = blob.match(new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`));
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return null;
  }
}

/** Parse a LiveTrack session page. Returns null if anything is not as expected. */
export function parseLiveTrackHtml(html: string, now = Date.now()): LiveSession | null {
  const blob = extractFlightPayload(html);
  if (blob.length === 0) return null;

  const pages = sliceArrays(blob, "trackPoints");
  if (pages.length === 0) return null;

  const parsed: RawPoint[] = [];
  for (const page of pages) {
    let pagePoints: RawPoint[];
    try {
      pagePoints = JSON.parse(page) as RawPoint[];
    } catch {
      // The first page failing means we read nothing usable; a later one
      // failing still leaves a shorter but honest track.
      if (parsed.length === 0) return null;
      continue;
    }
    parsed.push(...pagePoints);
  }

  // Pages arrive newest-first as often as not, and nothing guarantees they do
  // not overlap at the seams — so order by time and drop repeats rather than
  // trusting the sequence, which would otherwise draw the route as a zigzag.
  parsed.sort((a, b) => timeOf(a) - timeOf(b));

  const points: LivePoint[] = [];
  let lastTime = Number.NaN;
  for (const p of parsed) {
    const lat = p.position?.lat;
    const lon = p.position?.lon;
    if (typeof lat !== "number" || typeof lon !== "number") continue;
    const time = p.dateTime ? Date.parse(p.dateTime) || undefined : undefined;
    if (time !== undefined && time === lastTime) continue;
    if (time !== undefined) lastTime = time;
    points.push({
      lat,
      lng: lon,
      alt: typeof p.altitude === "number" ? p.altitude : undefined,
      time,
      distanceM: typeof p.totalDistanceMeters === "number" ? p.totalDistanceMeters : 0,
      moving: p.pointStatus !== "STATIONARY",
    });
  }
  // An empty session is a successful parse, not a failure: Garmin opens the
  // session when LiveTrack starts and the first points arrive later. Callers
  // need to tell "nothing yet" apart from "could not read the page".
  const last = parsed[parsed.length - 1];
  const endedAt = sliceString(blob, "end");
  const endMs = endedAt ? Date.parse(endedAt) : NaN;

  return {
    name: sliceString(blob, "sessionName"),
    activityType: sliceString(blob, "activityType"),
    startedAt: sliceString(blob, "start"),
    endedAt,
    // No end at all means we cannot tell, and claiming "over" would wrongly
    // hide a live ride — so only a demonstrably stale end counts.
    complete: Number.isFinite(endMs) && now - endMs > COMPLETE_AFTER_MS,
    points,
    // Garmin's totals are cumulative, so the largest is the running total even
    // if the last point of a page happens not to carry it.
    distanceM: Math.max(0, ...points.map((p) => p.distanceM)),
    durationS: Math.max(
      0,
      ...parsed.map((p) => (typeof p.totalDurationSecs === "number" ? p.totalDurationSecs : 0)),
    ),
    current: points.length > 0 ? points[points.length - 1] : null,
    updatedAt: last?.dateTime ?? null,
  };
}

/** Sort key for a raw point. Undated points keep their place at the front. */
function timeOf(p: RawPoint): number {
  const t = p.dateTime ? Date.parse(p.dateTime) : NaN;
  return Number.isFinite(t) ? t : 0;
}
