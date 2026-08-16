/**
 * The download centre: what a trip has to hand out, and the bytes themselves.
 *
 * Everything here is built on request rather than stored. `/archive` already
 * writes a whole trip to the `archives` bucket as one self-contained zip, and
 * that stays the thing for keeping a trip forever — this is the other half of
 * the same need, the one a reader of the family page has: *that* day's track,
 * *those* pictures, now, without the traveller being asked to send them.
 *
 * The photos handed out are the stored copies — 2048 px for anything that came
 * in over the compression threshold, the untouched file for everything else
 * (which is what a photo sent as a document is). The camera original never
 * reached us, so nothing here can pretend otherwise; the page says as much.
 */

import { zipSync } from "fflate";
import { supabase } from "./supabase.server";
import { getTripBySlug } from "./db.server";
import type { DbTrip } from "./db.server";
import { fromGeoJson, type TrackGeoJson, type TrackPoint } from "./track";
import { toGpxTracks, type GpxTrack } from "./gpx-export";
import { byPhotoTime, type OrderablePhoto } from "./photo-order";
import { transitMode, type TransitMode } from "./transport";
import { wholePlanAtSource } from "./bot-route.server";
import { loadRideOriginal } from "./originals.server";
import { cutPlanBetween } from "./route-cut";
import { riddenStretches, type StoredSegment } from "./day-stretches";
import { packListCsv } from "./packing";
import { listPackItems } from "./packing.server";

/**
 * How much a zip may weigh before it is refused.
 *
 * A serverless function builds the whole thing in memory — fflate has no
 * streaming path that survives the response being sent — so a trip with three
 * thousand photographs on it must not be attempted at all. The day zips are
 * always there, and the page says so where the refusal lands.
 */
const MAX_ZIP_BYTES = 150 * 1024 * 1024;

/** A day as the download centre lists it: what it holds, not what it looked like. */
export interface DownloadDay {
  dayNumber: number;
  date: string;
  color: string;
  /** Ridden kilometres, on the same terms as everywhere else — no transit. */
  km: number;
  transitModes: TransitMode[];
  hasTrack: boolean;
  /** Whether anything was pedalled — a day carried by train has ends but no ride. */
  hasRidden: boolean;
  photos: number;
}

export interface TripDownloads {
  name: string;
  startDate: string;
  endDate: string | null;
  days: DownloadDay[];
  totalPhotos: number;
  daysWithTrack: number;
  /** Whether the trip has a planned route to hand out at all. */
  hasPlan: boolean;
  /** How many things are on the packing list — zero hides its row entirely. */
  packItems: number;
}

interface TrackDayRow {
  day_number: number;
  track_segments: {
    geojson: TrackGeoJson;
    sport: string | null;
    started_at: string | null;
    /** The recording as it arrived, where thinning it for the page lost something. */
    source_path: string | null;
  }[];
}

/** A stored photo, as the zip needs it: where it is, and when it happened. */
interface ZipPhotoRow extends OrderablePhoto {
  storage_path: string;
  motion_path: string | null;
}

/** What the download centre page lists — counts only, no geometry, no URLs. */
export async function tripDownloads(slug: string): Promise<TripDownloads | null> {
  const trip = await getTripBySlug(slug);
  if (!trip) return null;

  const db = supabase();
  const [{ data: rows }, { count: planCount }, { count: packCount }] = await Promise.all([
    db
      .from("days")
      .select("day_number, date, color, track_segments(distance_m, sport), media(id)")
      .eq("trip_id", trip.id)
      .order("day_number"),
    db
      .from("plan_segments")
      .select("*", { count: "exact", head: true })
      .eq("trip_id", trip.id),
    db.from("pack_items").select("*", { count: "exact", head: true }).eq("trip_id", trip.id),
  ]);

  const days: DownloadDay[] = (rows ?? [])
    .map((d) => {
      const segments = d.track_segments as { distance_m: number; sport: string | null }[];
      const ridden = segments.filter((s) => transitMode(s.sport) === null);
      return {
        dayNumber: d.day_number,
        date: d.date,
        color: d.color,
        km: ridden.reduce((s, x) => s + x.distance_m, 0) / 1000,
        transitModes: [...new Set(segments.map((s) => transitMode(s.sport)).filter((m) => m !== null))],
        hasTrack: segments.length > 0,
        hasRidden: ridden.length > 0,
        photos: (d.media as { id: string }[]).length,
      };
    })
    // A day with neither a line nor a picture has nothing to offer here, even
    // though it may well have a note on the page.
    .filter((d) => d.hasTrack || d.photos > 0);

  return {
    name: trip.name,
    startDate: trip.start_date,
    endDate: trip.end_date,
    days,
    totalPhotos: days.reduce((s, d) => s + d.photos, 0),
    daysWithTrack: days.filter((d) => d.hasTrack).length,
    hasPlan: (planCount ?? 0) > 0,
    packItems: packCount ?? 0,
  };
}

/**
 * The packing list as a file.
 *
 * The one download here that is not a line or a picture: three columns and a
 * link per row, so a reader planning their own trip can take the list with them
 * — which is the whole reason the page shows it at all.
 */
export async function buildPackingCsv(
  slug: string,
): Promise<{ trip: DbTrip; csv: string } | null> {
  const trip = await getTripBySlug(slug);
  if (!trip) return null;
  const items = await listPackItems(trip.id);
  if (items.length === 0) return null;
  return { trip, csv: packListCsv(items) };
}

/**
 * The planned route as it was imported.
 *
 * The one file here that is not simply the page's own line written out. What
 * the row holds is thinned for drawing; what the `plans` bucket holds is the
 * line exactly as it came in, and that is what a reader importing this into a
 * mapping tool wants — the same reasoning, and the same machinery, as `/route`.
 * A plan imported before originals were kept falls back the way `/route` does:
 * Komoot, then the thinned line, which since it is thinned by shape is within a
 * few metres of the route anyway.
 */
export async function buildPlanGpx(
  slug: string,
  day: number | null,
): Promise<{ trip: DbTrip; gpx: string } | null> {
  const trip = await getTripBySlug(slug);
  if (!trip) return null;

  const plan = await wholePlanAtSource(trip.id);
  if (plan.points.length === 0) return null;
  if (day === null) {
    return { trip, gpx: toGpxTracks([{ name: `${trip.name} — plan`, segments: [plan.points] }]) };
  }

  const ends = await ridingEnds(trip, day);
  if (!ends) return null;
  const stretch = cutPlanBetween(plan.points, ends.from, ends.to);
  if (!stretch || stretch.points.length < 2) return null;
  return {
    trip,
    gpx: toGpxTracks([
      { name: `${trip.name} — day ${day} (plan)`, segments: [stretch.points] },
    ]),
  };
}

/**
 * Where a day's riding began and where it stopped.
 *
 * Ridden stretches only, and in the order they were ridden — `riddenStretches`
 * is the one answer to "what was pedalled, and where did it stop" that the
 * page, the share card and the archive all use, and this is not the place for a
 * fourth. A leg taken by train is left out of the ends deliberately: it is not
 * riding, and a day that ended on a platform ended where the pedalling did.
 *
 * The plan between those two points spans any such leg anyway — there is one
 * file per day, and the route it was planned along ran through that ground even
 * where the traveller was carried over it.
 */
async function ridingEnds(
  trip: DbTrip,
  day: number,
): Promise<{ from: TrackPoint; to: TrackPoint } | null> {
  const { data: row } = await supabase()
    .from("days")
    .select("track_segments(geojson, distance_m, sport, started_at)")
    .eq("trip_id", trip.id)
    .eq("day_number", day)
    .maybeSingle();
  if (!row) return null;

  // In the order they were ridden, as everywhere else that groups a day: the
  // first stretch's first point and the last stretch's last point are the ends,
  // and that is only true of segments in sequence.
  const segments = [...(row.track_segments as unknown as (StoredSegment & { started_at: string | null })[])]
    .sort((a, b) => Date.parse(a.started_at ?? "0") - Date.parse(b.started_at ?? "0"));
  // The line the page draws is enough to ask *where*: thinning moves a point by
  // metres, and both ends are then projected onto the plan regardless.
  const stretches = riddenStretches(segments);
  const first = stretches[0]?.points[0];
  const lastStretch = stretches[stretches.length - 1]?.points;
  const last = lastStretch?.[lastStretch.length - 1];
  return first && last ? { from: first, to: last } : null;
}

/** Days in order, geometry included — one day of them, or all of them. */
async function daysWithTracks(trip: DbTrip, day: number | null): Promise<TrackDayRow[]> {
  let query = supabase()
    .from("days")
    .select("day_number, track_segments(geojson, sport, started_at, source_path)")
    .eq("trip_id", trip.id)
    .order("day_number");
  if (day !== null) query = query.eq("day_number", day);
  const { data } = await query;
  return (data ?? []) as unknown as TrackDayRow[];
}

/**
 * A day's segments in the order they were ridden, each at the best resolution
 * there is for it.
 *
 * The row's `geojson` is the line the page draws, cut to a point budget on the
 * way in. Where that cut lost something the recording was kept whole, and this
 * is what it was kept for: a day handed to somebody who is going to open it in
 * a mapping tool should be the ride, not the drawing of it. Where no original
 * was kept the row *is* the original — nothing was dropped — so the fallback
 * costs nothing.
 */
async function segmentsOf(row: TrackDayRow) {
  const segments = [...row.track_segments].sort(
    (a, b) => Date.parse(a.started_at ?? "0") - Date.parse(b.started_at ?? "0"),
  );
  return Promise.all(
    segments.map(async (seg) => ({
      mode: transitMode(seg.sport),
      points: (await loadRideOriginal(seg.source_path)) ?? fromGeoJson(seg.geojson),
    })),
  );
}

async function gpxTracksFor(tripName: string, row: TrackDayRow): Promise<GpxTrack[]> {
  const segments = await segmentsOf(row);
  const ridden = segments.filter((s) => s.mode === null);
  const tracks: GpxTrack[] = [];
  if (ridden.length > 0) {
    tracks.push({
      name: `${tripName} — day ${row.day_number}`,
      segments: ridden.map((s) => s.points),
    });
  }
  // Each travelled leg on its own so it can be told apart from the riding at a
  // glance, exactly as the map does with its hatching.
  for (const seg of segments) {
    if (seg.mode === null) continue;
    tracks.push({
      name: `${tripName} — day ${row.day_number} (${seg.mode})`,
      segments: [seg.points],
    });
  }
  return tracks;
}

/** The GPX for one day or the whole trip, or null if there is no line in it. */
export async function buildDownloadGpx(
  slug: string,
  day: number | null,
): Promise<{ trip: DbTrip; gpx: string } | null> {
  const trip = await getTripBySlug(slug);
  if (!trip) return null;

  const rows = await daysWithTracks(trip, day);
  const tracks = (await Promise.all(rows.map((row) => gpxTracksFor(trip.name, row)))).flat();
  if (tracks.length === 0) return null;
  return { trip, gpx: toGpxTracks(tracks) };
}

export type PhotoZipResult =
  // The buffer is spelled out because a `Response` body will not take a
  // Uint8Array over the wider `ArrayBufferLike` that fflate's types return.
  | { ok: true; trip: DbTrip; zip: Uint8Array<ArrayBuffer> }
  | { ok: false; reason: "empty" | "too-large" };

/**
 * The photos of one day, or of the trip, as a zip.
 *
 * Named the way the archive names them — `day-3-02.jpg` — so a folder of them
 * still says which day each picture came from once it has left the page, and a
 * Live Photo's motion travels beside its still under the same stem.
 */
export async function buildPhotoZip(
  slug: string,
  day: number | null,
): Promise<PhotoZipResult | null> {
  const trip = await getTripBySlug(slug);
  if (!trip) return null;

  const db = supabase();
  let query = db
    .from("days")
    .select("day_number, media(storage_path, motion_path, caption, telegram_date, taken_at, created_at)")
    .eq("trip_id", trip.id)
    .order("day_number");
  if (day !== null) query = query.eq("day_number", day);
  const { data: rows } = await query;

  const files: Record<string, Uint8Array> = {};
  let bytes = 0;

  for (const row of rows ?? []) {
    const media = [...(row.media as unknown as ZipPhotoRow[])].sort(byPhotoTime);
    for (let i = 0; i < media.length; i++) {
      const m = media[i];
      // Photos sent as files keep their own format, so don't rename a PNG .jpg.
      const ext = /\.[a-z0-9]+$/i.exec(m.storage_path)?.[0] ?? ".jpg";
      const stem = `day-${row.day_number}-${String(i + 1).padStart(2, "0")}`;

      const { data: blob } = await db.storage.from("photos").download(m.storage_path);
      if (blob) {
        const buf = new Uint8Array(await blob.arrayBuffer());
        bytes += buf.byteLength;
        if (bytes > MAX_ZIP_BYTES) return { ok: false, reason: "too-large" };
        files[`${stem}${ext}`] = buf;
      }

      if (m.motion_path) {
        const motionExt = /\.[a-z0-9]+$/i.exec(m.motion_path)?.[0] ?? ".mp4";
        const { data: motionBlob } = await db.storage.from("photos").download(m.motion_path);
        if (motionBlob) {
          const buf = new Uint8Array(await motionBlob.arrayBuffer());
          bytes += buf.byteLength;
          if (bytes > MAX_ZIP_BYTES) return { ok: false, reason: "too-large" };
          files[`${stem}-live${motionExt}`] = buf;
        }
      }
    }
  }

  if (Object.keys(files).length === 0) return { ok: false, reason: "empty" };

  // Level 0: these are JPEGs and MP4s, already compressed. Deflating them costs
  // the whole request and gives back a percent or two — the zip here is a
  // container, not a compressor.
  return { ok: true, trip, zip: zipSync(files, { level: 0 }) as Uint8Array<ArrayBuffer> };
}
