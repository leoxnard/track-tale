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

export const DAY_COLORS = [
  "#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4",
  "#42d4f4", "#f032e6", "#bfef45", "#fabed4", "#469990",
  "#9a6324", "#800000", "#808000", "#000075", "#ffe119",
];

export function dayColor(dayNumber: number): string {
  return DAY_COLORS[(dayNumber - 1) % DAY_COLORS.length];
}
