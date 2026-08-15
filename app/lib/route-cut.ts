import { haversineM, type TrackPoint } from "./track";

/**
 * Cutting tomorrow's ride out of the planned route.
 *
 * The morning ritual this replaces was: open the whole plan in gpx.studio, find
 * roughly where you stopped yesterday, scrub the cursor along until the readout
 * says about the right number of kilometres, cut, export. Every step of that is
 * something the bot already knows — where you are, where the plan runs, and how
 * long a day you want — so it can hand you the file instead.
 *
 * Three decisions are worth spelling out, because the obvious version of each
 * is wrong in a way you only notice on the road.
 *
 * **The cut starts on the route, not at the position.** Where you slept is
 * rarely on the line — a village two kilometres off it, a campsite up a track.
 * So the file opens with the position itself, then joins the plan at the
 * nearest point on it, and only then follows the plan. That first leg is the
 * way back to the route, and without it the file starts in the middle of
 * nowhere and every navigation device spends the first hour recalculating.
 *
 * **The target counts plan kilometres, not file kilometres.** The join leg is
 * extra. Counting it against the target would make a day shrink for the sole
 * reason that you slept off the route, which is backwards — the ride back to
 * the line is exactly the part you did not choose. The join is measured and
 * reported separately instead, so a stale position that lands twenty kilometres
 * out is visible rather than silently eating the day.
 *
 * **The nearest point wins, full stop.** A tour that passes near itself — a
 * loop, an out-and-back, a valley ridden twice — has more than one candidate,
 * and there is no reliable tiebreak available here: the ridden track near the
 * position projects onto the same ambiguity, so it cannot vote. Rather than
 * guess with a heuristic that fails silently, the cut reports how far the
 * position sat from the line and where along the plan it landed, and both go in
 * front of the traveller, who can see at a glance that the answer is 40 km back
 * up the plan from where it should be.
 *
 * Times are deliberately dropped. A plan segment imported from a GPX may carry
 * the timestamps of whoever drew it, and a file with times in it reads as a
 * past activity to half the tools that open one.
 */

/** What a day is unless told otherwise. */
export const DEFAULT_TARGET_KM = 130;

/** The one-tap lengths under a cut. Anything else is /route 175. */
export const TARGET_CHOICES_KM = [80, 100, 110, 120, 130, 140, 150, 170];

/** The bounds a typed or nudged length is held inside. */
export const MIN_TARGET_KM = 5;
export const MAX_TARGET_KM = 400;

/** How much ± moves the length. */
export const TARGET_STEP_KM = 10;

export function clampTargetKm(km: number): number {
  return Math.min(MAX_TARGET_KM, Math.max(MIN_TARGET_KM, Math.round(km)));
}

export interface PlanCut {
  /** The position, the join point, then the plan up to the target. */
  points: TrackPoint[];
  /** Straight-line metres from the position to the plan. */
  joinM: number;
  /** Where along the plan the cut begins. */
  startM: number;
  /** Plan metres in the cut — the target, unless the plan ran out. */
  cutM: number;
  /** Plan metres left beyond the end of the cut. */
  remainingM: number;
  /** Whether the cut ran to the end of the plan rather than to the target. */
  reachedEnd: boolean;
}

/** Metres per degree of latitude, on the sphere the rest of the app uses. */
const M_PER_DEG = (Math.PI / 180) * 6371000;

/**
 * Two points this close together are the same place as far as a route file is
 * concerned, and repeating one only gives a device a zero-length leg to think
 * about.
 */
const SAME_PLACE_M = 5;

/**
 * Cut `targetM` metres of plan, starting where `from` joins it.
 *
 * Returns null only when there is no plan to cut — every other degenerate case
 * (a one-point plan, a position on the far side of the country, a target longer
 * than everything that is left) has a sensible answer and gives it.
 */
export function cutPlan(
  plan: TrackPoint[],
  from: { lat: number; lng: number },
  targetM: number,
): PlanCut | null {
  if (plan.length === 0) return null;

  const join = nearestOnPath(plan, from);

  // Cumulative plan distance, in true metres rather than the projected frame
  // the nearest-point search uses: the number goes in front of a traveller who
  // will compare it with a cycle computer.
  const cum = cumulative(plan);
  const totalM = cum[cum.length - 1];

  const startM = join.index === 0 ? 0 : cum[join.index - 1] + segmentSpan(plan, join.index, join.t);

  const points: TrackPoint[] = [{ lat: from.lat, lng: from.lng }];
  const joinPoint = join.point;
  const joinM = haversineM(points[0], joinPoint);
  if (joinM > SAME_PLACE_M) points.push(joinPoint);

  let walked = 0;
  let reachedEnd = true;
  let previous = joinPoint;
  for (let i = join.index; i < plan.length; i++) {
    const step = haversineM(previous, plan[i]);
    if (walked + step >= targetM) {
      // The last point sits exactly on the target rather than at whatever
      // vertex happens to follow it: a plan thinned to a vertex every two
      // kilometres would otherwise overshoot by up to that much.
      const t = step > 0 ? (targetM - walked) / step : 0;
      pushUnlessSamePlace(points, lerpPoint(previous, plan[i], t));
      walked = targetM;
      reachedEnd = false;
      break;
    }
    walked += step;
    pushUnlessSamePlace(points, stripTime(plan[i]));
    previous = plan[i];
  }

  return {
    points,
    joinM,
    startM,
    cutM: walked,
    remainingM: Math.max(0, totalM - startM - walked),
    reachedEnd,
  };
}

/**
 * The point on a polyline closest to a coordinate, as a vertex index, a
 * fraction into the segment that ends at it, and the coordinate itself.
 *
 * `plan-anchor.ts` answers a neighbouring question — how far along a plan a
 * coordinate falls — and deliberately is not reused: it returns a distance on
 * the plan's own declared scale and no position, and cutting needs the position
 * to start the file from and true metres to measure the day with.
 *
 * The projection into a local equirectangular frame is the same trick, though,
 * and for the same reason: at the scale of a day's ride the distortion is far
 * below anything being claimed, and it makes the search plain planar geometry.
 */
function nearestOnPath(
  plan: TrackPoint[],
  from: { lat: number; lng: number },
): { index: number; t: number; point: TrackPoint } {
  if (plan.length === 1) return { index: 0, t: 0, point: stripTime(plan[0]) };

  const lats = plan.map((p) => p.lat);
  const k = Math.cos((((Math.min(...lats) + Math.max(...lats)) / 2) * Math.PI) / 180);
  const x = (p: { lat: number; lng: number }) => p.lng * k * M_PER_DEG;
  const y = (p: { lat: number; lng: number }) => p.lat * M_PER_DEG;

  const px = x(from);
  const py = y(from);

  let bestGap = Infinity;
  let bestIndex = 1;
  let bestT = 0;
  for (let i = 1; i < plan.length; i++) {
    const ax = x(plan[i - 1]);
    const ay = y(plan[i - 1]);
    const dx = x(plan[i]) - ax;
    const dy = y(plan[i]) - ay;
    const len2 = dx * dx + dy * dy;
    // A repeated coordinate makes a zero-length segment; treat it as its vertex.
    const t = len2 > 0 ? clamp01(((px - ax) * dx + (py - ay) * dy) / len2) : 0;
    const gap = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (gap < bestGap) {
      bestGap = gap;
      bestIndex = i;
      bestT = t;
    }
  }

  return {
    index: bestIndex,
    t: bestT,
    point: lerpPoint(plan[bestIndex - 1], plan[bestIndex], bestT),
  };
}

function cumulative(plan: TrackPoint[]): number[] {
  const cum = [0];
  for (let i = 1; i < plan.length; i++) cum.push(cum[i - 1] + haversineM(plan[i - 1], plan[i]));
  return cum;
}

/** Metres from the vertex before `index` to a fraction `t` into that segment. */
function segmentSpan(plan: TrackPoint[], index: number, t: number): number {
  return haversineM(plan[index - 1], plan[index]) * t;
}

function pushUnlessSamePlace(points: TrackPoint[], point: TrackPoint) {
  const last = points[points.length - 1];
  if (last && haversineM(last, point) <= SAME_PLACE_M) return;
  points.push(point);
}

function lerpPoint(a: TrackPoint, b: TrackPoint, t: number): TrackPoint {
  const point: TrackPoint = {
    lat: a.lat + (b.lat - a.lat) * t,
    lng: a.lng + (b.lng - a.lng) * t,
  };
  // Elevation only where both ends have it: interpolating against an undefined
  // end would invent a sea-level vertex in the middle of a climb.
  if (a.alt !== undefined && b.alt !== undefined) point.alt = a.alt + (b.alt - a.alt) * t;
  return point;
}

function stripTime(p: TrackPoint): TrackPoint {
  return p.alt !== undefined ? { lat: p.lat, lng: p.lng, alt: p.alt } : { lat: p.lat, lng: p.lng };
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
