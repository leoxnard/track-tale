import { InlineKeyboard } from "grammy";
import { supabase } from "./supabase.server";
import { escapeMd } from "./telegram-md";
import { encodeAction } from "./manage";
import {
  computeStats,
  formatDistanceM,
  fromGeoJson,
  haversineM,
  type TrackGeoJson,
  type TrackPoint,
} from "./track";
import { buildPlanIndex } from "./plan-anchor";
import { fetchKomootTour, parseKomootUrl } from "./komoot";
import { loadPlanOriginal } from "./originals.server";
import { toGpx } from "./gpx-export";
import {
  cutPlan,
  TARGET_CHOICES_KM,
  TARGET_STEP_KM,
  clampTargetKm,
  type PlanCut,
} from "./route-cut";
import { DEFAULT_AHEAD_KM as SHOPS_AHEAD_KM } from "./shops";
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

interface PlanPiece {
  points: TrackPoint[];
  /** The Komoot tour this piece was imported from, where there was one. */
  sourceUrl: string | null;
  /** The untouched imported line in storage, where one was kept. */
  sourcePath: string | null;
}

/** The trip's plan as stored, one entry per imported segment, in order. */
async function loadPlanPieces(tripId: string): Promise<PlanPiece[]> {
  const { data: rows } = await supabase()
    .from("plan_segments")
    .select("geojson, source_url, source_path")
    .eq("trip_id", tripId)
    .order("sort_order");

  return (rows ?? []).map((row) => ({
    points: fromGeoJson(row.geojson as TrackGeoJson),
    sourceUrl: (row.source_url as string | null) ?? null,
    sourcePath: (row.source_path as string | null) ?? null,
  }));
}

/** The trip's plan, every segment laid end to end in the order it was added. */
export async function loadPlan(tripId: string): Promise<TrackPoint[]> {
  return (await loadPlanPieces(tripId)).flatMap((piece) => piece.points);
}

/**
 * How long /route will wait for Komoot before cutting from the stored plan.
 *
 * Short on purpose. The stored line is a perfectly good answer; the original is
 * a better one, and it is not worth more than a few seconds of a traveller
 * standing in a car park with a phone.
 */
const SOURCE_FETCH_TIMEOUT_MS = 7_000;

/**
 * The same wait for a download of the whole plan. Longer, because it is a
 * browser showing a spinner rather than a traveller at a roadside — and because
 * this one may have to re-fetch every segment of an old plan, not just the one
 * a day crosses.
 */
const WHOLE_PLAN_FETCH_TIMEOUT_MS = 20_000;

export interface PlanForCut {
  points: TrackPoint[];
  /** Segments the cut crosses that came from the kept original. */
  fromStore: number;
  /** Segments the cut crosses that had to be re-fetched from Komoot. */
  fromSource: number;
  /** Segments whose original could not be had, and were cut from the thinned line. */
  degraded: number;
}

/**
 * The plan to cut from — at the resolution it was drawn at, where that can be
 * had.
 *
 * This exists because of what the stored plan is: a *thinned* copy. The page
 * draws the whole tour on every visit, so what goes in the database is reduced
 * to a budget — and a line that is thinned enough to draw cheaply is not the
 * line a navigation device wants. Cut a day out of it and every bend it
 * smoothed is a stretch the importer cannot match to a road: Komoot marks those
 * off-grid, which is precisely what cutting the tour by hand in gpx.studio
 * never did, because that worked from the original export.
 *
 * So the original is used — but only for the segments the day actually crosses,
 * worked out first from the thinned copy, which is accurate enough to answer
 * *which* segment while being wrong about its corners. A day is normally one
 * segment.
 *
 * Three places that line can come from, in order:
 *
 * 1. The copy kept in storage at import. Exact, one read, no third party.
 * 2. Komoot, re-fetched. For plans imported before originals were kept — the
 *    nightly refresh fills those in, so this fades out on its own.
 * 3. The thinned line on the row. Correct to a few metres, and what a plan
 *    uploaded as GPX before this existed will always fall back to.
 *
 * Komoot never became a dependency and now is barely a fallback: anything that
 * fails or is slow drops to the next option down, and the caller is told when
 * the answer came from the thinned line so the file can be explained.
 */
export async function planForCut(
  tripId: string,
  from: { lat: number; lng: number },
  targetM: number,
): Promise<PlanForCut> {
  const pieces = await loadPlanPieces(tripId);
  if (pieces.length === 0) return { points: [], fromStore: 0, fromSource: 0, degraded: 0 };

  const spanned = piecesSpannedBy(pieces, from, targetM);
  return assemblePlan(pieces, (i) => spanned.has(i), SOURCE_FETCH_TIMEOUT_MS);
}

/**
 * The whole plan as it was imported — every segment, not just the ones a day
 * crosses.
 *
 * The download centre hands the plan to a reader who is going to open it in a
 * mapping tool, which is the same need `/route` has: a line thinned for drawing
 * describes a road that bends less than the real one. Normally this is now one
 * storage read per segment and no third party at all. The Komoot fallback is
 * still behind it for plans imported before originals were kept, and it is
 * given longer than `/route` allows, because nobody is standing in a car park
 * waiting for this one.
 */
export async function wholePlanAtSource(tripId: string): Promise<PlanForCut> {
  const pieces = await loadPlanPieces(tripId);
  if (pieces.length === 0) return { points: [], fromStore: 0, fromSource: 0, degraded: 0 };
  return assemblePlan(pieces, () => true, WHOLE_PLAN_FETCH_TIMEOUT_MS);
}

/**
 * Lay the plan end to end, at full resolution for the pieces `wanted` picks out
 * and as thinned for the rest.
 *
 * The three sources are tried in the order the header above gives them, per
 * piece. Everything that fails lands in the same place — the thinned line on
 * the row — and only `degraded` tells the two kinds of "as stored" apart,
 * because a piece that never had an original is not a piece that lost one.
 */
async function assemblePlan(
  pieces: PlanPiece[],
  wanted: (index: number) => boolean,
  timeoutMs: number,
): Promise<PlanForCut> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let fromStore = 0;
  let fromSource = 0;
  let degraded = 0;
  try {
    const fetched = await Promise.all(
      pieces.map(async (piece, i) => {
        if (!wanted(i)) return null;

        const kept = await loadPlanOriginal(piece.sourcePath);
        if (kept) return { points: kept, kept: true };

        const ref = parseKomootUrl(piece.sourceUrl ?? "");
        // Nothing kept and nothing to fetch: an old GPX plan, whose thinned
        // line is the only line there has ever been. Not a degraded answer —
        // there is no better one to have been denied.
        if (!ref) return null;
        try {
          const tour = await fetchKomootTour(ref, controller.signal);
          return { points: tour.points, kept: false };
        } catch {
          return "failed" as const;
        }
      }),
    );

    const points: TrackPoint[] = [];
    // Appended one by one rather than spread in: an original fetched at full
    // resolution can be hundreds of thousands of points, and `push(...points)`
    // passes every one of them as an argument — which is a stack overflow, not
    // a route, somewhere north of a hundred thousand.
    const append = (from: TrackPoint[]) => {
      for (const point of from) points.push(point);
    };
    fetched.forEach((result, i) => {
      if (result === "failed") {
        degraded++;
        append(pieces[i].points);
      } else if (result) {
        if (result.kept) fromStore++;
        else fromSource++;
        append(result.points);
      } else {
        append(pieces[i].points);
      }
    });
    return { points, fromStore, fromSource, degraded };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Which stored segments a cut of `targetM` starting at `from` runs through.
 *
 * Answered on the stored geometry, and that is sound even though the stored
 * geometry is what this is all working around: thinning moves a line by metres,
 * and this question is decided by kilometres. One segment further than needed
 * costs one request; one too few would leave the far end of the day cut from
 * the thinned copy, so the walk deliberately keeps going while any of the
 * target is unaccounted for.
 */
function piecesSpannedBy(
  pieces: PlanPiece[],
  from: { lat: number; lng: number },
  targetM: number,
): Set<number> {
  let startAt = 0;
  let startD = 0;
  let bestGap = Infinity;
  pieces.forEach((piece, i) => {
    const anchor = buildPlanIndex(piece.points).anchor(from);
    if (anchor && anchor.gap < bestGap) {
      bestGap = anchor.gap;
      startAt = i;
      startD = anchor.d;
    }
  });

  const spanned = new Set<number>([startAt]);
  let left = targetM - (pieceLength(pieces[startAt]) - startD);
  for (let i = startAt + 1; i < pieces.length && left > 0; i++) {
    spanned.add(i);
    left -= pieceLength(pieces[i]);
  }
  return spanned;
}

function pieceLength(piece: PlanPiece): number {
  let sum = 0;
  for (let i = 1; i < piece.points.length; i++) {
    sum += haversineM(piece.points[i - 1], piece.points[i]);
  }
  return sum;
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
export function buildCutRoute(
  trip: DbTrip,
  position: Position,
  targetKm: number,
  cut: PlanCut,
  degraded = 0,
): CutRoute {
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
      `↩️ ${formatDistanceM(cut.joinM)} back to the plan first — the file starts where you are.`,
    );
  }
  // Worth saying out loud, because the file is the thing that will be judged:
  // a stored plan is thinned, and an importer may not match every bend of it to
  // a road. Silence here would look like the route itself being wrong.
  if (degraded > 0) {
    lines.push(
      `⚠️ Komoot didn't answer, so this is cut from the stored plan — a few bends ` +
        `may be smoothed. /route again in a minute for the original line.`,
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
  // Where to buy food on the stretch that was just cut. It belongs here rather
  // than only behind /supermarkt because a location sent to the bot is never
  // stored — this button is what carries that position forward.
  keyboard
    .row()
    .text(`🛒 Shops (${SHOPS_AHEAD_KM} km)`, encodeAction({ type: "shops", km: SHOPS_AHEAD_KM, ...at }));
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
  const km = clampTargetKm(targetKm);
  const plan = position
    ? await planForCut(trip.id, position, km * 1000)
    : { points: await loadPlan(trip.id), fromStore: 0, fromSource: 0, degraded: 0 };
  if (plan.points.length === 0) {
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

  const cut = cutPlan(plan.points, position, km * 1000);
  if (!cut) return { error: "The plan on this trip has no coordinates in it." };
  return buildCutRoute(trip, position, km, cut, plan.degraded);
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
