import { InlineKeyboard } from "grammy";
import { supabase } from "./supabase.server";
import { escapeMd } from "./telegram-md";
import { encodeAction } from "./manage";
import { computeStats, fromGeoJson, type TrackGeoJson, type TrackPoint } from "./track";
import { toGpx } from "./gpx-export";
import {
  cutPlan,
  TARGET_CHOICES_KM,
  TARGET_STEP_KM,
  clampTargetKm,
  type PlanCut,
} from "./route-cut";
import type { DbTrip } from "./db.server";

/**
 * `/route` — tomorrow's stage, cut out of the plan and handed over as a GPX.
 *
 * The cutting itself is `route-cut.ts` and is pure. What lives here is the
 * other half of the job: working out *where the traveller is* without asking
 * them to tell it, and putting the answer in the chat.
 *
 * Where they are has three possible answers, and the order matters:
 *
 * 1. A location pinned in the chat, if one came with the command. Always right,
 *    because someone just said so.
 * 2. The end of the newest track — where yesterday's ride stopped, which is
 *    where this morning starts unless the night moved you.
 * 3. The newest photo that knows where it was taken. This is not a fallback for
 *    a trip with no tracks so much as one for the common case where the day's
 *    ride has not been uploaded yet but breakfast has been photographed.
 *
 * 2 and 3 compete on time rather than on rank: a photo taken at eight this
 * morning beats a track that ended at six last night, and the same track beats
 * a photo from the day before. Whichever wins is named in the message, because
 * a cut that begins in the wrong town is only obvious if the bot says which
 * town it thinks you are in.
 */

export interface Position {
  lat: number;
  lng: number;
  /** What to call it in the message: "your last track", "a pinned location". */
  source: string;
  /** When the position was true, where that is known. */
  at?: Date;
}

/** Days looked back through for a position. See `lastKnownPosition`. */
const POSITION_LOOKBACK_DAYS = 3;

/**
 * The most recent place the trip knows the traveller was.
 *
 * Only the last few days are read. Every track's geojson is the full ride, so
 * pulling the whole trip to find its newest point would fetch megabytes to use
 * the last coordinate of one of them — and a position older than a couple of
 * days is not one to cut a route from anyway.
 */
export async function lastKnownPosition(tripId: string): Promise<Position | null> {
  const { data: days } = await supabase()
    .from("days")
    .select(
      "day_number, track_segments(geojson, started_at, created_at), media(matched_lat, matched_lng, taken_at, telegram_date)",
    )
    .eq("trip_id", tripId)
    .order("day_number", { ascending: false })
    .limit(POSITION_LOOKBACK_DAYS);

  let best: Position | null = null;
  const consider = (candidate: Position) => {
    if (!best || (candidate.at?.getTime() ?? 0) > (best.at?.getTime() ?? 0)) best = candidate;
  };

  for (const day of days ?? []) {
    for (const segment of day.track_segments ?? []) {
      const points = fromGeoJson(segment.geojson as TrackGeoJson);
      const last = points[points.length - 1];
      if (!last) continue;
      // The last point's own clock first: a segment started at six in the
      // morning may have ended nine hours later, and it is the end that says
      // where the traveller is.
      const at = last.time
        ? new Date(last.time)
        : new Date(segment.started_at ?? segment.created_at);
      consider({ lat: last.lat, lng: last.lng, source: "the end of your last track", at });
    }
    for (const photo of day.media ?? []) {
      if (photo.matched_lat == null || photo.matched_lng == null) continue;
      consider({
        lat: photo.matched_lat,
        lng: photo.matched_lng,
        source: "your last photo",
        at: new Date(photo.taken_at ?? photo.telegram_date),
      });
    }
  }

  return best;
}

/** The trip's plan, every segment laid end to end in the order it was added. */
export async function loadPlan(tripId: string): Promise<TrackPoint[]> {
  const { data: rows } = await supabase()
    .from("plan_segments")
    .select("geojson")
    .eq("trip_id", tripId)
    .order("sort_order");

  return (rows ?? []).flatMap((row) => fromGeoJson(row.geojson as TrackGeoJson));
}

export interface CutRoute {
  cut: PlanCut;
  gpx: string;
  filename: string;
  caption: string;
  keyboard: InlineKeyboard;
}

/**
 * Everything a `/route` reply is made of: the file, what to call it, what to
 * say about it, and the lengths that are one tap away.
 */
export function buildCutRoute(trip: DbTrip, position: Position, targetKm: number, cut: PlanCut): CutRoute {
  const km = clampTargetKm(targetKm);
  const stats = computeStats(cut.points);
  // Named for what was actually cut rather than what was asked for: the last
  // day of a tour is whatever is left, and calling that file 130 km would be a
  // lie carried onto the device.
  const cutKm = Math.round(cut.cutM / 1000);
  const name = `${trip.name} — next ${cutKm} km`;

  const lines = [
    `🗺 *${escapeMd(name)}*`,
    `${(cut.cutM / 1000).toFixed(1)} km of plan` +
      (stats.elevationUp > 0 ? `, ${Math.round(stats.elevationUp)} m up` : ""),
    `📍 From ${escapeMd(position.source)}${positionAge(position)}`,
  ];

  // A joining leg is drawn as a straight line, so it is worth naming: it is the
  // one part of the file that is not a route anyone planned, and how long it is
  // says whether the position was a sensible one to cut from.
  if (cut.joinM > 50) {
    lines.push(
      `↩️ ${formatDistance(cut.joinM)} back to the plan first — the file starts where you are.`,
    );
  }
  if (cut.reachedEnd) {
    lines.push(`🏁 That is the end of the plan — nothing left after it.`);
  } else {
    lines.push(`Plan left after this: ${(cut.remainingM / 1000).toFixed(0)} km.`);
  }

  return {
    cut,
    gpx: toGpx(name, [cut.points]),
    filename: `${slugify(trip.name)}-next-${cutKm}km.gpx`,
    caption: lines.join("\n"),
    keyboard: targetKeyboard(km, position),
  };
}

/**
 * The lengths, and a nudge either side of the one in hand.
 *
 * The buttons carry the position they were cut from rather than looking it up
 * again on the tap. Re-resolving it would be a second answer to "where are
 * you" — from a photo that arrived in between, or from a location that is no
 * longer the one pinned — and a button that quietly changes the start point
 * under a traveller comparing 120 with 140 is worse than a stale one.
 */
function targetKeyboard(km: number, position: Position): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const at = { lat: position.lat, lng: position.lng };

  const PER_ROW = 4;
  TARGET_CHOICES_KM.forEach((choice, i) => {
    keyboard.text(
      choice === km ? `· ${choice} km ·` : `${choice} km`,
      encodeAction({ type: "cut", km: choice, ...at }),
    );
    // Ending the last row here as well would leave an empty one behind when the
    // choices divide evenly into rows, which Telegram draws as a gap.
    if (i % PER_ROW === PER_ROW - 1 && i !== TARGET_CHOICES_KM.length - 1) keyboard.row();
  });
  keyboard.row();
  keyboard
    .text(`− ${TARGET_STEP_KM} km`, encodeAction({ type: "cut", km: clampTargetKm(km - TARGET_STEP_KM), ...at }))
    .text(`+ ${TARGET_STEP_KM} km`, encodeAction({ type: "cut", km: clampTargetKm(km + TARGET_STEP_KM), ...at }));
  return keyboard;
}

/**
 * Cut the plan, or say what is missing.
 *
 * The two failures are worth different sentences: a trip with no plan cannot
 * answer this at all, and a trip whose traveller has not been seen yet needs a
 * location rather than an apology.
 */
export async function cutForTrip(
  trip: DbTrip,
  position: Position | null,
  targetKm: number,
): Promise<CutRoute | { error: string }> {
  const plan = await loadPlan(trip.id);
  if (plan.length === 0) {
    return {
      error:
        "No plan on this trip yet, so there is nothing to cut from. Send the planned " +
        "Komoot link, or a GPX with the caption \"plan\", and /route will work from it.",
    };
  }
  if (!position) {
    return {
      error:
        "I don't know where you are yet — no track and no located photo in the last few days. " +
        "Send me a location (📎 → Location) and I'll cut the route from there.",
    };
  }

  const km = clampTargetKm(targetKm);
  const cut = cutPlan(plan, position, km * 1000);
  if (!cut) return { error: "The plan on this trip has no coordinates in it." };
  return buildCutRoute(trip, position, km, cut);
}

/** "1.2 km" under ten, "340 m" below that: metres matter at walking scale. */
function formatDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

/** " (2 h ago)" — silent when the position came with no clock on it. */
function positionAge(position: Position): string {
  if (!position.at || Number.isNaN(position.at.getTime())) return "";
  const minutes = Math.round((Date.now() - position.at.getTime()) / 60000);
  if (minutes < 2) return " (just now)";
  if (minutes < 90) return ` (${minutes} min ago)`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return ` (${hours} h ago)`;
  return ` (${Math.round(hours / 24)} days ago)`;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "trip";
}
