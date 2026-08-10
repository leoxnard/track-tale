import { buildPlanIndex, median, theilSenSlope } from "./plan-anchor";
import type { ProfilePoint, TrackPoint } from "./track";

/**
 * Laying each ridden day over the stretch of the planned route it covered.
 *
 * The alternative — stacking days end to end by distance — reads plausibly and
 * lies: one shortcut on day two shifts every day after it, so the chart shows
 * the traveller further along the plan than they are. Anchoring instead means a
 * gap or an overlap between two days is information, not an artefact.
 *
 * Which is exactly why the anchoring has to be accurate. A day pinned a few
 * kilometres early swallows the end of the day before it and invents an overlap
 * that never happened, and the reader has no way to tell that from a real one.
 *
 * The axis is distance along the plan, so a day occupies the stretch of plan it
 * covered — not its own odometer reading. Those differ, always and by a lot: a
 * real day rides 95 km to advance 86 km of route, because a detour, a wrong
 * turn or a loop round a lake all cost distance the route does not count. Drawn
 * at its ridden width a day therefore overhangs the stretch it covered at both
 * ends, and the front end lands on top of the day before it. That was the bug
 * this file was rewritten for: two days that ran seamlessly into each other,
 * drawn overlapping by kilometres.
 *
 * So each day gets a robust straight-line fit from its own distance onto the
 * plan's — position *and* scale — rather than a position alone. The ridden
 * distance is not lost: it is what the day's own stats and the tour total say.
 *
 * A day is not always one continuous ride, either. Ride to Aberdeen, take the
 * train to Forres, ride on: fitted as one, those two stretches are drawn as a
 * single line straight across 133 km nobody pedalled. Each stretch is
 * therefore fitted on its own, and the plan between them is left showing.
 */

/** One stretch ridden without a break in it. */
export interface TourPiece {
  /** Authoritative distance for the stretch, from the tracks' own stats. */
  distanceM: number;
  /** Elevation series on its own distance axis, starting at zero. */
  profile: ProfilePoint[];
}

export interface TourDayInput {
  dayNumber: number;
  color: string;
  /**
   * The day's riding, in stretches. Normally one. A day interrupted — a train
   * from Aberdeen to Forres — is several, and each is anchored onto the plan
   * on its own. That is what leaves the plan bare across the interruption
   * instead of drawing a flat line over ground nobody rode.
   */
  pieces: TourPiece[];
}

export interface LaidDay {
  dayNumber: number;
  color: string;
  /** Which stretch of the day this is; 0 unless the day was interrupted. */
  piece: number;
  /** Where the stretch begins along the plan, in metres. */
  startM: number;
  endM: number;
  /** The stretch's profile, re-based onto the plan's distance axis. */
  points: ProfilePoint[];
}

export interface TourLayout {
  laid: LaidDay[];
  /** Total distance actually ridden. */
  riddenM: number;
  /** Furthest point reached along the plan, which is not the same thing. */
  reachedM: number;
}

/**
 * Past this, the nearest point on the plan is too far away to mean anything —
 * a rest day in a city, or a plan that was abandoned. Only a coarse gate: the
 * median across many anchors is what actually rejects a bad match.
 */
const MAX_ANCHOR_GAP_M = 25_000;

/**
 * Fractions along a day's own profile used to anchor it to the plan.
 *
 * Deliberately excludes 0 and 1: the start and end of a day are often off the
 * planned route, since a bed for the night rarely sits on the tour line, while
 * the middle of the day is usually still on it.
 *
 * Sampled across the day rather than at a couple of points, because each anchor
 * is one independent guess and the median of nine survives a stretch where the
 * route doubles back near itself.
 */
const ANCHOR_FRACTIONS = [
  0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5,
  0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95,
];

/** Below this many usable anchors there is nothing worth fitting a line to. */
const MIN_ANCHORS = 3;

/**
 * Plausible range for "plan metres per ridden metre".
 *
 * A day always rides at least a little further than the route advances, so the
 * honest values sit a bit under 1. The bounds are wide enough to leave those
 * alone and only catch a fit that has gone wrong — a day that returns to where
 * it started covers no route at all and would otherwise be squashed to nothing,
 * and a mismatched anchor at one end can produce a slope of any size.
 */
const MIN_SCALE = 0.25;
const MAX_SCALE = 4;

/**
 * @param planPoints the plan's raw coordinates — full resolution, elevation not
 *   required. Anchoring is about shape, and the drawn grey line is thinned and
 *   altitude-only, so it is the wrong thing to match against.
 * @param planM the authoritative planned distance; anchors come back on it.
 */
export function layDays(
  planPoints: TrackPoint[],
  planM: number,
  days: TourDayInput[],
): TourLayout {
  const plan = buildPlanIndex(planPoints, planM);

  const laid: LaidDay[] = [];
  let cursor = 0;
  let riddenM = 0;

  for (const day of days) {
    for (const [index, piece] of day.pieces.entries()) {
      const span = piece.profile[piece.profile.length - 1]?.d ?? 0;
      const width = piece.distanceM > 0 ? piece.distanceM : span;
      riddenM += width;
      if (piece.profile.length < 2 || width <= 0) {
        cursor += width;
        continue;
      }

      // Each anchor pairs a distance along the stretch with the distance along
      // the plan it fell at. Together they are the line to fit.
      const anchors: { x: number; y: number }[] = [];
      for (const f of ANCHOR_FRACTIONS) {
        const p = piece.profile[Math.round(f * (piece.profile.length - 1))];
        const anchor = plan.anchor(p);
        if (anchor && anchor.gap < MAX_ANCHOR_GAP_M) anchors.push({ x: p.d, y: anchor.d });
      }

      // Falling back means keeping the stretch's own length and sitting it
      // behind the one before — the honest answer for riding the plan says
      // nothing about.
      let scale = width / (span || 1);
      let startM = cursor;

      if (anchors.length >= MIN_ANCHORS) {
        const fitted = theilSenSlope(anchors);
        if (Number.isFinite(fitted) && fitted >= MIN_SCALE && fitted <= MAX_SCALE) scale = fitted;
        // Intercept of the same fit, taken as a median so one bad anchor cannot
        // shift the stretch. Days are allowed to overlap — that is the point —
        // but none of them starts before the plan does.
        startM = Math.max(0, median(anchors.map((a) => a.y - scale * a.x)));
      }

      const drawnWidth = scale * span;
      laid.push({
        dayNumber: day.dayNumber,
        color: day.color,
        piece: index,
        startM,
        endM: startM + drawnWidth,
        points: piece.profile.map((p) => ({ ...p, d: startM + scale * p.d })),
      });
      cursor = startM + drawnWidth;
    }
  }

  return { laid, riddenM, reachedM: laid.reduce((m, d) => Math.max(m, d.endM), 0) };
}
