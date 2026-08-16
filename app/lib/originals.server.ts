import { gunzipSync, gzipSync } from "node:zlib";
import { supabase } from "./supabase.server";
import { fromGeoJson, toGeoJson, type TrackGeoJson, type TrackPoint } from "./track";

/**
 * Keeping a line as it was imported, for the two kinds of line that get handed
 * back out as a file.
 *
 * Both kinds are stored on the row in a form sized for *drawing*. A plan is
 * thinned to a budget because the family page redraws the whole tour on every
 * visit; a ride is cut to 4 000 points for the same reason. Either copy is a
 * fine map and a poor file: `/route` cuts a day out of the plan and hands it to
 * a device, and the download centre hands a day's ride to whoever asks for it —
 * and every metre the stored line differs from the recorded one is a metre
 * nobody rode.
 *
 * For the plan, re-fetching the original from Komoot at cut time was the first
 * answer, and it leaned on an unofficial API for something the bot could simply
 * have kept. A ride has no such fallback at all: a FIT file recorded at one
 * point a second is gone the moment it has been thinned, and nothing on the
 * internet has a copy. So both are stored once, at import, exactly as they came
 * in.
 *
 * Stored as gzipped GeoJSON rather than as the GPX or FIT it arrived as: every
 * source has already been normalised to `TrackPoint[]` by the time it gets
 * here, so keeping the normalised form means one shape to read back instead of
 * three to parse. It also fixes the stored precision at six decimals — eleven
 * centimetres, and the same grid the GPX handed to a device is written on, so
 * nothing survives the round trip that would have survived the export. Gzip
 * because a line sampled every few metres is mostly repeated digits: a long
 * tour compresses to well under a third of its JSON.
 *
 * Two buckets rather than one, mirroring the two tables, so a trip's originals
 * are swept by prefix the same way its photos are.
 */

const PLAN_BUCKET = "plans";
const RIDE_BUCKET = "tracks";

/** Where one segment's original lives. One object per segment, overwritten in place. */
function pathFor(tripId: string, segmentId: string): string {
  return `${tripId}/${segmentId}.json.gz`;
}

export function encodeOriginal(points: TrackPoint[]): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(toGeoJson(points)), "utf8"));
}

export function decodeOriginal(data: Buffer): TrackPoint[] {
  return fromGeoJson(JSON.parse(gunzipSync(data).toString("utf8")) as TrackGeoJson);
}

/**
 * Put a segment's original away, and return the path to record on the row.
 *
 * Never throws. A segment whose original could not be stored is a segment that
 * works exactly as it did before this existed — the thinned line, and for a
 * plan the Komoot re-fetch behind it — and failing an import over it would
 * trade a working feature for a missing one.
 */
async function store(
  bucket: string,
  tripId: string,
  segmentId: string,
  points: TrackPoint[],
): Promise<string | null> {
  if (points.length === 0) return null;
  const path = pathFor(tripId, segmentId);
  try {
    const { error } = await supabase()
      .storage.from(bucket)
      .upload(path, encodeOriginal(points), {
        contentType: "application/gzip",
        // A re-imported segment keeps its id, so its original is replaced.
        upsert: true,
      });
    if (error) throw error;
    return path;
  } catch (err) {
    console.error(`could not store original in ${bucket}`, err);
    return null;
  }
}

/**
 * Read a stored original back. Null when there is none, or when the bucket
 * cannot be reached — both mean "fall back", and neither is worth an exception
 * in the middle of answering /route or a download.
 */
async function load(bucket: string, path: string | null): Promise<TrackPoint[] | null> {
  if (!path) return null;
  try {
    const { data, error } = await supabase().storage.from(bucket).download(path);
    if (error || !data) return null;
    const points = decodeOriginal(Buffer.from(await data.arrayBuffer()));
    return points.length > 0 ? points : null;
  } catch (err) {
    console.error(`could not read original from ${bucket}`, err);
    return null;
  }
}

async function remove(bucket: string, path: string | null): Promise<void> {
  if (!path) return;
  await supabase().storage.from(bucket).remove([path]).catch(() => {});
}

export const storePlanOriginal = (tripId: string, segmentId: string, points: TrackPoint[]) =>
  store(PLAN_BUCKET, tripId, segmentId, points);

export const loadPlanOriginal = (path: string | null) => load(PLAN_BUCKET, path);

/** Drop a stored original, when the segment it belongs to is deleted. */
export const removePlanOriginal = (path: string | null) => remove(PLAN_BUCKET, path);

export const storeRideOriginal = (tripId: string, segmentId: string, points: TrackPoint[]) =>
  store(RIDE_BUCKET, tripId, segmentId, points);

export const loadRideOriginal = (path: string | null) => load(RIDE_BUCKET, path);

export const removeRideOriginal = (path: string | null) => remove(RIDE_BUCKET, path);
