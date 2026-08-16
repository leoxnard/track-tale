import { gunzipSync, gzipSync } from "node:zlib";
import { supabase } from "./supabase.server";
import { fromGeoJson, toGeoJson, type TrackGeoJson, type TrackPoint } from "./track";

/**
 * Keeping the planned route as it was imported.
 *
 * The `geojson` column on a plan segment is a *thinned* copy — the family page
 * redraws the whole tour on every visit, so what goes in the row is sized for
 * drawing. That copy is a fine map and a poor route file: `/route` cuts a day
 * out of the plan and hands it to a device, and every metre the stored line
 * differs from the road is a metre the device has to reconcile.
 *
 * Re-fetching the original from Komoot at cut time answers that, and it was the
 * first answer — but it leans on an unofficial API for something the bot could
 * simply have kept, costs a request or two on every /route, and does nothing at
 * all for a plan that arrived as an uploaded GPX, which has no source to go back
 * to. So the line is stored once, at import, exactly as it came in.
 *
 * Stored as gzipped GeoJSON rather than as the GPX it may have arrived as:
 * every source — Komoot, GPX, FIT — has already been normalised to
 * `TrackPoint[]` by the time it gets here, so keeping the normalised form means
 * one shape to read back instead of three to parse. It also fixes the stored
 * precision at six decimals — eleven centimetres, and the same grid the GPX
 * that goes to a device is written on, so nothing survives the round trip that
 * would have survived the export. Gzip because a route sampled every few metres
 * is mostly repeated digits: a long tour compresses to well under a third of
 * its JSON.
 */

const BUCKET = "plans";

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
 * Never throws. A plan whose original could not be stored is a plan that works
 * exactly as it did before this existed — thinned line, Komoot re-fetch at cut
 * time — and failing the import over it would trade a working feature for a
 * missing one.
 */
export async function storePlanOriginal(
  tripId: string,
  segmentId: string,
  points: TrackPoint[],
): Promise<string | null> {
  if (points.length === 0) return null;
  const path = pathFor(tripId, segmentId);
  try {
    const { error } = await supabase()
      .storage.from(BUCKET)
      .upload(path, encodeOriginal(points), {
        contentType: "application/gzip",
        // A re-imported segment keeps its id, so its original is replaced.
        upsert: true,
      });
    if (error) throw error;
    return path;
  } catch (err) {
    console.error("could not store plan original", err);
    return null;
  }
}

/**
 * Read a stored original back. Null when there is none, or when the bucket
 * cannot be reached — both mean "fall back", and neither is worth an exception
 * in the middle of answering /route.
 */
export async function loadPlanOriginal(path: string | null): Promise<TrackPoint[] | null> {
  if (!path) return null;
  try {
    const { data, error } = await supabase().storage.from(BUCKET).download(path);
    if (error || !data) return null;
    const points = decodeOriginal(Buffer.from(await data.arrayBuffer()));
    return points.length > 0 ? points : null;
  } catch (err) {
    console.error("could not read plan original", err);
    return null;
  }
}

/** Drop a stored original, when the segment it belongs to is deleted. */
export async function removePlanOriginal(path: string | null): Promise<void> {
  if (!path) return;
  await supabase().storage.from(BUCKET).remove([path]).catch(() => {});
}
