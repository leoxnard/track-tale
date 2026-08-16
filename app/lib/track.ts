/** Normalized track representation shared by Komoot, GPX and FIT ingestion. */

export interface TrackPoint {
  lat: number;
  lng: number;
  /** meters above sea level */
  alt?: number;
  /** epoch milliseconds */
  time?: number;
}

export interface TrackStats {
  distanceM: number;
  durationS: number;
  movingS: number;
  elevationUp: number;
  elevationDown: number;
  startedAt?: string;
}

export interface NormalizedTrack {
  name?: string;
  sport?: string;
  points: TrackPoint[];
  stats: TrackStats;
}

const EARTH_RADIUS_M = 6371000;

export function haversineM(a: TrackPoint, b: TrackPoint): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/**
 * How the bot says a distance out loud: metres up close, kilometres past one.
 *
 * One function rather than one per caller, because the three that grew
 * independently — how far along a ride, how far off a route, how far back to
 * the plan — had all landed on the same rule and would have drifted apart at
 * the first tweak.
 */
export function formatDistanceM(m: number): string {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}

/** Hysteresis threshold so GPS altitude noise doesn't inflate elevation gain. */
const ELEVATION_THRESHOLD_M = 3;
/** Below this speed between samples we consider the traveler stopped. */
const MOVING_SPEED_MS = 0.5;

export function computeStats(points: TrackPoint[]): TrackStats {
  let distanceM = 0;
  let movingS = 0;
  let elevationUp = 0;
  let elevationDown = 0;
  let anchorAlt = points.find((p) => p.alt !== undefined)?.alt;

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const d = haversineM(prev, curr);
    distanceM += d;

    if (prev.time !== undefined && curr.time !== undefined) {
      const dt = (curr.time - prev.time) / 1000;
      if (dt > 0 && d / dt >= MOVING_SPEED_MS) movingS += dt;
    }

    if (curr.alt !== undefined && anchorAlt !== undefined) {
      const diff = curr.alt - anchorAlt;
      if (diff >= ELEVATION_THRESHOLD_M) {
        elevationUp += diff;
        anchorAlt = curr.alt;
      } else if (diff <= -ELEVATION_THRESHOLD_M) {
        elevationDown += -diff;
        anchorAlt = curr.alt;
      }
    }
  }

  const first = points.find((p) => p.time !== undefined);
  const last = [...points].reverse().find((p) => p.time !== undefined);
  const durationS =
    first?.time !== undefined && last?.time !== undefined
      ? (last.time - first.time) / 1000
      : 0;

  return {
    distanceM,
    durationS,
    movingS,
    elevationUp,
    elevationDown,
    startedAt: first?.time ? new Date(first.time).toISOString() : undefined,
  };
}

/** Sort split-activity segments by start time so a day reads as one journey. */
export function sortSegmentsByStart<T extends { startedAt?: string | null }>(
  segments: T[],
): T[] {
  return [...segments].sort((a, b) => {
    const ta = a.startedAt ? Date.parse(a.startedAt) : 0;
    const tb = b.startedAt ? Date.parse(b.startedAt) : 0;
    return ta - tb;
  });
}

export interface TrackGeoJson {
  type: "Feature";
  properties: { times?: (number | null)[]; alts?: (number | null)[] };
  geometry: { type: "LineString"; coordinates: [number, number][] };
}

/** Keep coordinates compact: [lng, lat] pairs, times/alts as parallel arrays. */
export function toGeoJson(points: TrackPoint[]): TrackGeoJson {
  const times = points.map((p) => p.time ?? null);
  const alts = points.map((p) => (p.alt !== undefined ? Math.round(p.alt * 10) / 10 : null));
  // An array of nothing but nulls is worth more as an absent array: a planned
  // route has no clock at all, so that is ten thousand `null`s stored, shipped
  // to the page and parsed there to say what a missing key says for free.
  // `fromGeoJson` and everything downstream already read these as optional,
  // because a track saved before either field existed looks exactly like this.
  const kept = <T>(values: (T | null)[]) => (values.some((v) => v !== null) ? values : undefined);
  return {
    type: "Feature",
    properties: { times: kept(times), alts: kept(alts) },
    geometry: {
      type: "LineString",
      coordinates: points.map((p) => [
        Math.round(p.lng * 1e6) / 1e6,
        Math.round(p.lat * 1e6) / 1e6,
      ]),
    },
  };
}

export function fromGeoJson(geojson: TrackGeoJson): TrackPoint[] {
  const times = geojson.properties?.times;
  const alts = geojson.properties?.alts;
  return geojson.geometry.coordinates.map(([lng, lat], i) => ({
    lat,
    lng,
    alt: alts?.[i] ?? undefined,
    time: times?.[i] ?? undefined,
  }));
}

/**
 * Reduce point count for rendering payloads by keeping every nth point.
 *
 * Not Douglas-Peucker, whatever this comment used to claim: the stride is on
 * the *index*, so which points survive has nothing to do with where the line
 * bends. On a ride drawn at map scale that is fine and cheap. On anything that
 * has to keep its shape — a plan that will be cut into a route file and handed
 * to a navigation device — it is not: a hairpin whose apex falls between two
 * kept indices becomes a chord straight across the bend. Use `thinPlan` there.
 */
export function decimate(points: TrackPoint[], maxPoints = 2000): TrackPoint[] {
  if (points.length <= maxPoints) return points;
  const step = Math.ceil(points.length / maxPoints);
  const out = points.filter((_, i) => i % step === 0);
  if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
  return out;
}

/**
 * How many points a planned tour is worth keeping, given how long it is.
 *
 * A day's ride gets a flat budget because a day is a day. A plan is not: it can
 * be a weekend loop or six weeks across a continent, and a fixed budget spends
 * the same detail on both — lavish on the loop, and on the long one so coarse
 * that switchbacks turn into straight lines. Scaling by distance keeps the
 * resolution *per kilometre* constant instead, at roughly a point every 100 m:
 * 1000 points for a 100 km day's worth of plan, 10 000 for a 1000 km tour.
 *
 * A point every 333 m, which this used to be, is invisible on a map of a whole
 * country and plainly wrong as soon as anyone zooms into a valley: a hairpin
 * becomes a corner and a lakeside road cuts across the water. 100 m is about
 * where a zoomed-in plan stops disagreeing with the road under it, and the
 * payload is still smaller than a single photograph.
 *
 * It also feeds the elevation chart, which matches each ridden day to the
 * nearest place on the planned line — the denser that line, the closer the
 * match lands to where the day actually rejoined the plan.
 */
export const PLAN_POINTS_PER_KM = 10;

/**
 * Below this a short plan would be thinned into a sketch; above it the page
 * pays. The ceiling is per *segment*, and a plan is normally sent one Komoot
 * tour at a time, so a long trip reaches its full detail as a dozen segments
 * that each stay well under it — it only bites on a single uploaded file
 * carrying more than 2000 km in one piece.
 */
const PLAN_MIN_POINTS = 500;
const PLAN_MAX_POINTS = 20_000;

/**
 * Thin a line without changing its shape more than `toleranceM`.
 *
 * Douglas-Peucker, properly: the point furthest from the chord between two ends
 * is kept if it is further than the tolerance, and the two halves are then
 * simplified in turn. What comes out is guaranteed to sit within the tolerance
 * of the original everywhere — so a straight kilometre costs two points and a
 * hairpin keeps every point it needs to still be a hairpin.
 *
 * Iterative rather than recursive: a Komoot export of a long tour arrives with
 * hundreds of thousands of points, and the recursion depth on a near-straight
 * stretch of those is a stack overflow rather than a route.
 */
export function simplify(points: TrackPoint[], toleranceM: number): TrackPoint[] {
  if (points.length <= 2 || toleranceM <= 0) return points;

  // One local equirectangular frame for the whole line, as everywhere else in
  // the app: at these scales the distortion is far below the tolerances anyone
  // is setting here, and it turns the perpendicular distance into arithmetic.
  const lats = points.map((p) => p.lat);
  const k = Math.cos((((Math.min(...lats) + Math.max(...lats)) / 2) * Math.PI) / 180);
  const M_PER_DEG = (Math.PI / 180) * EARTH_RADIUS_M;
  const xs = points.map((p) => p.lng * k * M_PER_DEG);
  const ys = points.map((p) => p.lat * M_PER_DEG);

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    if (last - first < 2) continue;

    const dx = xs[last] - xs[first];
    const dy = ys[last] - ys[first];
    const len2 = dx * dx + dy * dy;

    let worst = 0;
    let worstAt = -1;
    for (let i = first + 1; i < last; i++) {
      // Distance to the segment, not to the infinite line: where the two ends
      // coincide — a loop that returns to its own start — the "line" has no
      // direction and every point would measure as zero away from it.
      const t = len2 > 0 ? clampUnit(((xs[i] - xs[first]) * dx + (ys[i] - ys[first]) * dy) / len2) : 0;
      const gap = Math.hypot(xs[i] - (xs[first] + t * dx), ys[i] - (ys[first] + t * dy));
      if (gap > worst) {
        worst = gap;
        worstAt = i;
      }
    }

    if (worstAt >= 0 && worst > toleranceM) {
      keep[worstAt] = 1;
      stack.push([first, worstAt], [worstAt, last]);
    }
  }

  return points.filter((_, i) => keep[i] === 1);
}

function clampUnit(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * The tolerances tried when thinning a plan to fit its budget, in metres.
 *
 * It starts at a metre, already below what a GPS fix or a drawn route is worth
 * arguing about, and climbs slowly through the range where a line is still
 * plainly on its road — a carriageway is about six metres wide, and importers
 * match to a way with tens of metres of slack.
 *
 * It runs further than it should ever need to on purpose. A budget of ten
 * points per kilometre is comfortable at three metres for an alpine route with
 * switchbacks in it — measured, not guessed — but "comfortable" is not "always",
 * and what used to happen past the end of this ladder was a fall back to
 * keeping every nth point. That is the silent cliff this whole exercise exists
 * to remove: it swaps a line three metres off its road for one a hundred metres
 * off it, in the one case nobody would think to check.
 */
const PLAN_TOLERANCES_M = [1, 2, 3, 5, 8, 12, 20];

/**
 * Thin a planned route to its budget while keeping its shape.
 *
 * The budget exists for the page — a plan is drawn on every visit — but the
 * same stored line is what `/route` cuts a day's GPX out of, and a device is
 * far less forgiving than a map: where every-nth thinning cut a corner, the
 * road the file describes leaves the road that exists, and an importer flags
 * the stretch as off-grid because it cannot match it to a way.
 *
 * So the thinning is by *shape error* rather than by count: the smallest
 * tolerance that fits the budget wins, and the line that comes out is within
 * that many metres of the original everywhere. A tour with long straight
 * stretches keeps its full detail through the bends and pays nothing for the
 * straights, which is the opposite of what a stride does.
 */
export function thinPlan(points: TrackPoint[], maxPoints: number): TrackPoint[] {
  if (points.length <= maxPoints) return points;

  let thinned = points;
  for (const tolerance of PLAN_TOLERANCES_M) {
    thinned = simplify(points, tolerance);
    if (thinned.length <= maxPoints) return thinned;
  }

  // Past the widest tolerance the budget loses, and deliberately: what comes
  // back is still within twenty metres of the original everywhere, where a
  // stride to fit the count would put arbitrary chords across the bends. The
  // budget protects a page render; the shape is what a route file means. No
  // route this side of a coastline traced by hand ever gets here.
  return thinned;
}

export function planPointBudget(distanceM: number): number {
  const km = Number.isFinite(distanceM) && distanceM > 0 ? distanceM / 1000 : 0;
  const wanted = Math.round(km * PLAN_POINTS_PER_KM);
  return Math.min(PLAN_MAX_POINTS, Math.max(PLAN_MIN_POINTS, wanted));
}

/**
 * How far apart two segments may be and still count as one ride.
 *
 * A day split into several uploads resumes where it stopped, give or take the
 * few hundred metres of a lunch stop the tracker was off for. A day that
 * resumes a hundred kilometres away did not ride the bit in between — there
 * was a train — and joining the two would draw a ride that never happened.
 */
export const RESUME_GAP_M = 1000;

/**
 * Group consecutive segments that carry on from one another, as index lists.
 *
 * Indices rather than points, because the caller holds the authoritative
 * distance for each segment and has to add up the same grouping.
 */
export function groupContinuous(segments: TrackPoint[][], gapM = RESUME_GAP_M): number[][] {
  const groups: number[][] = [];
  let openEnd: TrackPoint | undefined;

  segments.forEach((points, index) => {
    if (points.length === 0) return;
    if (openEnd && haversineM(openEnd, points[0]) <= gapM) {
      groups[groups.length - 1].push(index);
    } else {
      groups.push([index]);
    }
    openEnd = points[points.length - 1];
  });

  return groups;
}

export interface ProfilePoint {
  /** cumulative metres from the start of the day */
  d: number;
  /** smoothed elevation in metres */
  e: number;
  lng: number;
  lat: number;
}

/**
 * Cumulative distance/elevation series for a day's chart.
 *
 * Raw GPS altitude is noisy enough to look like a seismograph, so the line is
 * smoothed with a moving average — the headline climb figure still comes from
 * the authoritative stats, not from this.
 */
export function buildProfile(points: TrackPoint[], maxPoints = 240): ProfilePoint[] {
  const withAlt = points.filter((p) => p.alt !== undefined);
  if (withAlt.length < 2) return [];

  const cumulative: number[] = [0];
  for (let i = 1; i < withAlt.length; i++) {
    cumulative.push(cumulative[i - 1] + haversineM(withAlt[i - 1], withAlt[i]));
  }

  const window = Math.max(1, Math.round(withAlt.length / 120));
  const smoothed = withAlt.map((_, i) => {
    const from = Math.max(0, i - window);
    const to = Math.min(withAlt.length - 1, i + window);
    let sum = 0;
    for (let j = from; j <= to; j++) sum += withAlt[j].alt as number;
    return sum / (to - from + 1);
  });

  const step = Math.max(1, Math.ceil(withAlt.length / maxPoints));
  const out: ProfilePoint[] = [];
  for (let i = 0; i < withAlt.length; i += step) {
    out.push({
      d: Math.round(cumulative[i]),
      e: Math.round(smoothed[i] * 10) / 10,
      lng: Math.round(withAlt[i].lng * 1e5) / 1e5,
      lat: Math.round(withAlt[i].lat * 1e5) / 1e5,
    });
  }
  const lastIdx = withAlt.length - 1;
  if (out[out.length - 1]?.d !== Math.round(cumulative[lastIdx])) {
    out.push({
      d: Math.round(cumulative[lastIdx]),
      e: Math.round(smoothed[lastIdx] * 10) / 10,
      lng: Math.round(withAlt[lastIdx].lng * 1e5) / 1e5,
      lat: Math.round(withAlt[lastIdx].lat * 1e5) / 1e5,
    });
  }
  return out;
}

/**
 * Lay a day's stretches end to end on one distance axis.
 *
 * Each stretch measures from its own zero, so this is what turns them back
 * into a single series to scrub along — without the ground between them,
 * which is the point: that ground was not ridden.
 */
export function layEndToEnd(pieces: ProfilePoint[][]): ProfilePoint[] {
  let offset = 0;
  const out: ProfilePoint[] = [];
  for (const piece of pieces) {
    for (const p of piece) out.push({ ...p, d: p.d + offset });
    offset += piece[piece.length - 1]?.d ?? 0;
  }
  return out;
}

export const DAY_COLORS = [
  "#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4",
  "#42d4f4", "#f032e6", "#bfef45", "#fabed4", "#469990",
  "#9a6324", "#800000", "#808000", "#000075", "#ffe119",
];

export function dayColor(dayNumber: number): string {
  return DAY_COLORS[(dayNumber - 1) % DAY_COLORS.length];
}
