#!/usr/bin/env node --experimental-strip-types
/**
 * Cut a ferry (or train, or bus) out of a track segment that was imported as
 * one ride.
 *
 * A Komoot tour recorded straight through a crossing arrives as a single
 * segment, so the boat's kilometres sit in the day's distance, its climb in
 * the day's climb, and the progress bar counts ground nobody pedalled. The
 * fix is per segment, because that is where the mode lives (see
 * app/lib/transport.ts): the day becomes ride · crossing · ride, and only the
 * ridden rows are added up.
 *
 * The original row is rewritten in place as the first ridden part rather than
 * deleted and replaced, so anything already pointing at it — a /delete button
 * in the chat, say — still points at the day it did before.
 *
 * Pick the indices off the track itself: a crossing is a straight line at a
 * steady speed no bicycle holds, usually with a wait at the quay in front of
 * it. `--dry-run` prints what it would write, including the endpoints of every
 * part, which is how you check that a cut lands on the water and not in a
 * village.
 *
 *   node --experimental-strip-types scripts/split-transit.ts \
 *     --segment 0173e7f3-50f3-48ca-b33e-9ede0d2d219b \
 *     --cut 160-219:ferry:"Fähre Helsingør – Helsingborg" \
 *     --dry-run
 *
 * Several `--cut`s are allowed for a day with more than one crossing; they may
 * not overlap. Needs SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment.
 */

import { createClient } from "@supabase/supabase-js";
import {
  apportionStats,
  fromGeoJson,
  splitAtTransit,
  toGeoJson,
  type TrackGeoJson,
  type TransitCut,
} from "../app/lib/track.ts";
import { TRANSIT_MODES } from "../app/lib/transport.ts";

interface Options {
  segment: string;
  cuts: TransitCut[];
  dryRun: boolean;
}

function parseArgs(argv: string[]): Options {
  const cuts: TransitCut[] = [];
  let segment = "";
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--segment") segment = argv[++i];
    else if (arg === "--cut") cuts.push(parseCut(argv[++i]));
    else throw new Error(`Unknown argument ${arg}`);
  }

  if (!segment) throw new Error("--segment <uuid> is required");
  if (cuts.length === 0) throw new Error("At least one --cut from-to:mode[:name] is required");
  return { segment, cuts, dryRun };
}

/** `160-219:ferry:Fähre Helsingør – Helsingborg` */
function parseCut(spec: string): TransitCut {
  const match = spec?.match(/^(\d+)-(\d+):([a-z]+)(?::(.+))?$/);
  if (!match) throw new Error(`Cannot read --cut ${spec}; want from-to:mode[:name]`);
  const [, from, to, sport, name] = match;
  if (!(TRANSIT_MODES as readonly string[]).includes(sport)) {
    throw new Error(`${sport} is not one of ${TRANSIT_MODES.join(", ")}`);
  }
  return { from: Number(from), to: Number(to), sport, name };
}

const round = (value: number) => Math.round(value * 1000) / 1000;

async function main() {
  const { segment: segmentId, cuts, dryRun } = parseArgs(process.argv.slice(2));

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set");
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const { data: row, error } = await supabase
    .from("track_segments")
    .select(
      "id, day_id, geojson, distance_m, duration_s, moving_s, elevation_up, elevation_down, sport, name, source, source_url",
    )
    .eq("id", segmentId)
    .single();
  if (error || !row) throw new Error(`No track segment ${segmentId}: ${error?.message}`);

  const points = fromGeoJson(row.geojson as TrackGeoJson);
  const parts = apportionStats(
    splitAtTransit(points, cuts, { sport: row.sport ?? undefined, name: row.name ?? undefined }),
    {
      distanceM: row.distance_m,
      durationS: row.duration_s,
      movingS: row.moving_s,
      elevationUp: row.elevation_up,
      elevationDown: row.elevation_down,
    },
  );

  const rows = parts.map((part) => ({
    day_id: row.day_id,
    geojson: toGeoJson(part.points),
    distance_m: round(part.stats.distanceM),
    duration_s: round(part.stats.durationS),
    moving_s: round(part.stats.movingS),
    elevation_up: round(part.stats.elevationUp),
    elevation_down: round(part.stats.elevationDown),
    sport: part.sport ?? null,
    name: part.name ?? null,
    source: row.source,
    source_url: row.source_url,
    started_at: part.stats.startedAt ?? null,
  }));

  for (const [i, part] of parts.entries()) {
    const first = part.points[0];
    const last = part.points[part.points.length - 1];
    console.log(
      `${i + 1}. ${rows[i].sport ?? "ridden"} · ${(rows[i].distance_m / 1000).toFixed(2)} km · ` +
        `${first.lat.toFixed(4)},${first.lng.toFixed(4)} → ${last.lat.toFixed(4)},${last.lng.toFixed(4)}` +
        `${rows[i].name ? ` · ${rows[i].name}` : ""}`,
    );
  }

  if (dryRun) {
    console.log("--dry-run: nothing written");
    return;
  }

  // The first part keeps the original row's identity; the rest are new.
  const [first, ...rest] = rows;
  const update = await supabase.from("track_segments").update(first).eq("id", segmentId);
  if (update.error) throw new Error(`Rewriting ${segmentId} failed: ${update.error.message}`);
  if (rest.length > 0) {
    const insert = await supabase.from("track_segments").insert(rest);
    if (insert.error) throw new Error(`Adding the new parts failed: ${insert.error.message}`);
  }
  console.log(`Wrote ${rows.length} segments for day ${row.day_id}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
