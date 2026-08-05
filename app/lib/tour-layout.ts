import { buildPlanIndex, median } from "./plan-anchor";
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
 */

export interface TourDayInput {
  dayNumber: number;
  color: string;
  /** Authoritative distance for the day, from the track's own stats. */
  distanceM: number;
  profile: ProfilePoint[];
}

export interface LaidDay extends TourDayInput {
  /** Where the day begins along the plan, in metres. */
  startM: number;
  endM: number;
  /** The day's profile, re-based onto the plan's distance axis. */
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
const ANCHOR_FRACTIONS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

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
    const span = day.profile[day.profile.length - 1]?.d ?? 0;
    const width = day.distanceM > 0 ? day.distanceM : span;
    riddenM += width;
    if (day.profile.length < 2 || width <= 0) {
      cursor += width;
      continue;
    }

    // Where a profile point ends up on the chart. The day is drawn stretched
    // from its measured profile length onto its authoritative distance, so an
    // offset taken against the unstretched position would tilt the whole day by
    // the difference — several kilometres on a long one, all of it landing on
    // top of the day before.
    const drawnD = (p: ProfilePoint) => (p.d / (span || 1)) * width;

    const offsets: number[] = [];
    for (const f of ANCHOR_FRACTIONS) {
      const p = day.profile[Math.round(f * (day.profile.length - 1))];
      const anchor = plan.anchor(p);
      if (anchor && anchor.gap < MAX_ANCHOR_GAP_M) offsets.push(anchor.d - drawnD(p));
    }

    // A day that never came near the plan can't be anchored to it; fall back to
    // sitting behind the previous day.
    const startM = offsets.length > 0 ? Math.max(0, median(offsets)) : cursor;

    laid.push({
      ...day,
      startM,
      endM: startM + width,
      points: day.profile.map((p) => ({ ...p, d: startM + drawnD(p) })),
    });
    cursor = startM + width;
  }

  return { laid, riddenM, reachedM: laid.reduce((m, d) => Math.max(m, d.endM), 0) };
}
