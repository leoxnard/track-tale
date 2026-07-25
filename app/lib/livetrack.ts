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
 * Slice out a JSON array by balancing brackets from `"<key>":[`.
 *
 * Written by hand because the array sits inside a much larger blob that is not
 * itself valid JSON. String literals are skipped so a bracket inside a value
 * cannot end the scan early.
 */
function sliceArray(blob: string, key: string): string | null {
  const at = blob.indexOf(`"${key}":[`);
  if (at === -1) return null;
  const start = blob.indexOf("[", at);

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

  const raw = sliceArray(blob, "trackPoints");
  if (!raw) return null;

  let parsed: RawPoint[];
  try {
    parsed = JSON.parse(raw) as RawPoint[];
  } catch {
    return null;
  }

  const points: LivePoint[] = [];
  for (const p of parsed) {
    const lat = p.position?.lat;
    const lon = p.position?.lon;
    if (typeof lat !== "number" || typeof lon !== "number") continue;
    points.push({
      lat,
      lng: lon,
      alt: typeof p.altitude === "number" ? p.altitude : undefined,
      time: p.dateTime ? Date.parse(p.dateTime) || undefined : undefined,
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
    distanceM: points.length > 0 ? points[points.length - 1].distanceM : 0,
    durationS: typeof last?.totalDurationSecs === "number" ? last.totalDurationSecs : 0,
    current: points.length > 0 ? points[points.length - 1] : null,
    updatedAt: last?.dateTime ?? null,
  };
}
