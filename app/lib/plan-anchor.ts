import type { TrackPoint } from "./track";

/**
 * Where a coordinate falls along the planned route.
 *
 * This is what lets the whole-tour chart lay each ridden day over the stretch
 * of plan it actually covered, rather than stacking days end to end. Getting it
 * wrong is not subtle: a day anchored a few kilometres early swallows the end
 * of the day before it, and the chart claims an overlap that never happened.
 *
 * Two things make that easy to get wrong, and both are handled here.
 *
 * The first is resolution. A planned route is a polyline, and its vertices can
 * be a kilometre or more apart — Komoot thins straight stretches to almost
 * nothing, and a hand-drawn GPX may have only a handful of waypoints. Matching
 * a coordinate to the *nearest vertex* therefore quantises every answer to
 * whatever spacing the plan happens to have, and half that spacing is pure
 * error even for a day ridden exactly on the line. Projecting onto the nearest
 * *segment* instead makes the answer as accurate as the route's shape, not as
 * its point count.
 *
 * The second is that elevation is not needed for any of this, so it must not be
 * required: a plan exported without it still has a perfectly good shape to
 * match against.
 */

/** Metres per degree of latitude, on the sphere the rest of the app uses. */
const M_PER_DEG = (Math.PI / 180) * 6371000;

export interface PlanAnchor {
  /** Distance along the plan, on the scale the index was built with. */
  d: number;
  /** How far the queried coordinate was from the route, in metres. */
  gap: number;
}

export interface PlanIndex {
  /** Length of the plan on that same scale. 0 when there is no plan. */
  totalM: number;
  anchor(p: { lat: number; lng: number }): PlanAnchor | null;
}

/**
 * Index a planned route for repeated nearest-point queries.
 *
 * `totalM` is the authoritative planned distance — the sum the plan segments
 * were imported with. Distances come back on that scale rather than the one
 * measured off the drawn coordinates, so anchors line up with the chart's own
 * axis. Pass nothing to use the measured length.
 *
 * Everything is projected once into a local equirectangular frame in metres.
 * At the scale of a tour the distortion is far below the accuracy anything here
 * is claiming, and it makes the per-query work plain planar geometry.
 */
export function buildPlanIndex(points: TrackPoint[], totalM?: number): PlanIndex {
  if (points.length === 0) {
    return { totalM: 0, anchor: () => null };
  }

  const lats = points.map((p) => p.lat);
  const k = Math.cos((((Math.min(...lats) + Math.max(...lats)) / 2) * Math.PI) / 180);

  const xs = points.map((p) => p.lng * k * M_PER_DEG);
  const ys = points.map((p) => p.lat * M_PER_DEG);

  // Cumulative length at each vertex, measured in the same frame the queries
  // are answered in so a projected fraction of a segment stays consistent.
  const cum = new Float64Array(points.length);
  for (let i = 1; i < points.length; i++) {
    cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
  }
  const measuredM = cum[cum.length - 1];
  const scale = totalM !== undefined && totalM > 0 && measuredM > 0 ? totalM / measuredM : 1;

  return {
    totalM: measuredM * scale,
    anchor(p) {
      const px = p.lng * k * M_PER_DEG;
      const py = p.lat * M_PER_DEG;

      // A one-point plan has no segment to project onto, only a place to be near.
      if (points.length === 1) {
        return { d: 0, gap: Math.hypot(px - xs[0], py - ys[0]) };
      }

      let bestGap = Infinity;
      let bestD = 0;
      for (let i = 1; i < points.length; i++) {
        const dx = xs[i] - xs[i - 1];
        const dy = ys[i] - ys[i - 1];
        const len2 = dx * dx + dy * dy;
        // Repeated coordinates make a zero-length segment; treat it as its vertex.
        const t = len2 > 0 ? clamp01(((px - xs[i - 1]) * dx + (py - ys[i - 1]) * dy) / len2) : 0;
        const gap = Math.hypot(px - (xs[i - 1] + t * dx), py - (ys[i - 1] + t * dy));
        if (gap < bestGap) {
          bestGap = gap;
          bestD = (cum[i - 1] + t * Math.sqrt(len2)) * scale;
        }
      }
      return { d: bestD, gap: bestGap };
    },
  };
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * The median, which is what turns a handful of independent anchors into one
 * position for a day. A mean would be dragged off by a single anchor that
 * matched the wrong part of a route passing close to itself; the median needs
 * half of them to be wrong before it moves.
 */
export function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Slope of the line through a set of points, by Theil–Sen: the median of the
 * slopes between every pair of them.
 *
 * Used to answer "how many metres of plan does this day cover per metre it
 * rode" — which is rarely one. A day with a detour, a wrong turn, or a loop
 * round a lake rides further than the route advances, and a day that took a
 * shortcut rides less.
 *
 * Median-of-pairs rather than least squares for the same reason the position
 * uses a median: one anchor that matched a stretch of route passing close by is
 * enough to tilt a fitted line, and tilting the fit throws the whole day out at
 * both ends. Returns NaN when there is nothing to fit.
 */
export function theilSenSlope(points: { x: number; y: number }[]): number {
  const slopes: number[] = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dx = points[j].x - points[i].x;
      if (dx !== 0) slopes.push((points[j].y - points[i].y) / dx);
    }
  }
  return slopes.length > 0 ? median(slopes) : NaN;
}
