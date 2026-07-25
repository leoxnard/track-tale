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

export interface LiveSession {
  name: string | null;
  activityType: string | null;
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
export function parseLiveTrackHtml(html: string): LiveSession | null {
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
  if (points.length === 0) return null;

  const last = parsed[parsed.length - 1];
  return {
    name: sliceString(blob, "sessionName"),
    activityType: sliceString(blob, "activityType"),
    points,
    distanceM: points[points.length - 1].distanceM,
    durationS: typeof last?.totalDurationSecs === "number" ? last.totalDurationSecs : 0,
    current: points[points.length - 1],
    updatedAt: last?.dateTime ?? null,
  };
}
