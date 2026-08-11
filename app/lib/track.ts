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
  return {
    type: "Feature",
    properties: {
      times: points.map((p) => p.time ?? null),
      alts: points.map((p) => (p.alt !== undefined ? Math.round(p.alt * 10) / 10 : null)),
    },
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

/** Reduce point count for rendering payloads (Douglas-Peucker light: every-nth + endpoints). */
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
 * resolution *per kilometre* constant instead, at roughly a point every 333 m:
 * 300 points for a 100 km day's worth of plan, 3000 for a 1000 km tour.
 *
 * It also feeds the elevation chart, which matches each ridden day to the
 * nearest place on the planned line — the denser that line, the closer the
 * match lands to where the day actually rejoined the plan.
 */
export const PLAN_POINTS_PER_KM = 3;

/** Below this a short plan would be thinned into a sketch; above it the page pays. */
const PLAN_MIN_POINTS = 500;
const PLAN_MAX_POINTS = 20_000;

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

/**
 * A stretch inside a recorded track that was travelled rather than ridden.
 *
 * Indices are inclusive and name the *shore* points: `from` is the last point
 * before the boat pulls out, `to` the first one back on land. Both ends are
 * kept by the ridden parts as well, so the day's line stays continuous where
 * the crossing is cut out of it.
 */
export interface TransitCut {
  from: number;
  to: number;
  /** The transit mode, stored in the segment's `sport` column. */
  sport: string;
  name?: string;
}

export interface TrackPart {
  points: TrackPoint[];
  stats: TrackStats;
  sport?: string;
  name?: string;
}

/**
 * One recorded track cut into the parts it is really made of.
 *
 * A day imported as a single tour can contain a ferry: the line belongs on the
 * map, the kilometres do not belong in what was ridden. Splitting it into
 * ridden / transit / ridden rows is what lets the rest of the app tell them
 * apart, because the distinction lives per segment.
 */
export function splitAtTransit(
  points: TrackPoint[],
  cuts: TransitCut[],
  ridden: { sport?: string; name?: string } = {},
): TrackPart[] {
  const ordered = [...cuts].sort((a, b) => a.from - b.from);
  const parts: TrackPart[] = [];
  let cursor = 0;

  const push = (slice: TrackPoint[], sport?: string, name?: string) => {
    if (slice.length < 2) return;
    parts.push({ points: slice, stats: computeStats(slice), sport, name });
  };

  for (const cut of ordered) {
    if (cut.from < cursor || cut.to <= cut.from || cut.to >= points.length) {
      throw new Error(`Transit cut ${cut.from}–${cut.to} is out of order or out of range`);
    }
    push(points.slice(cursor, cut.from + 1), ridden.sport, ridden.name);
    push(points.slice(cut.from, cut.to + 1), cut.sport, cut.name);
    cursor = cut.to;
  }
  push(points.slice(cursor), ridden.sport, ridden.name);

  return parts;
}

/**
 * Spread a segment's stored stats over the parts it was split into.
 *
 * Komoot's own figures for a tour are the ones the trip has always shown, and
 * they are not quite what re-adding the GPS points gives. Splitting a day must
 * not quietly restate its total, so each part takes its share of the official
 * figure rather than its own recomputed one. Durations are left alone: they
 * come from the timestamps, and the parts already add up because they share
 * their boundary points.
 */
export function apportionStats(parts: TrackPart[], official: TrackStats): TrackPart[] {
  const share = (pick: (s: TrackStats) => number) => {
    const total = parts.reduce((sum, p) => sum + pick(p.stats), 0);
    const target = pick(official);
    return (part: TrackPart) => (total > 0 ? (pick(part.stats) / total) * target : 0);
  };

  const distance = share((s) => s.distanceM);
  const moving = share((s) => s.movingS);
  const up = share((s) => s.elevationUp);
  const down = share((s) => s.elevationDown);

  return parts.map((part) => ({
    ...part,
    stats: {
      ...part.stats,
      distanceM: distance(part),
      movingS: moving(part),
      elevationUp: up(part),
      elevationDown: down(part),
    },
  }));
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
