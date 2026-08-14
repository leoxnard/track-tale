/**
 * What the wind actually did to the riding.
 *
 * A day's weather already carried a single "max wind" number, which says
 * nothing a cyclist cares about: 30 km/h is a gift for six hours and a
 * punishment for the same six. What matters is the angle between where the
 * wind came from and where the bike was pointing, kilometre by kilometre.
 *
 * So this walks the track pair by pair, asks the day's hourly wind what it was
 * doing at that moment and in that place, and adds the answer up **weighted by
 * distance** rather than by time. Distance is the honest weight: an hour spent
 * at a café with the flags snapping is not an hour of headwind, and a pair of
 * points a stationary rider produced carries almost no distance, so it fades
 * out of the average on its own without any stopped-time rule to tune.
 *
 * Two conventions, both easy to get backwards and both checked by the tests:
 *
 * - Wind direction is meteorological — the direction the wind blows *from*.
 *   A westerly (270°) pushes you east.
 * - The relative angle δ is measured between the wind's source and the
 *   direction of travel. δ = 0 means the wind comes from exactly where you are
 *   heading: a pure headwind. δ = 180 is a pure tailwind.
 *
 * Everything here is pure so the family page, the tests and the preview can all
 * run it; the fetching lives in `weather.ts`.
 */

import { haversineM, type TrackPoint } from "./track";
import type { HourlyWind } from "./weather";

/** A 16-point rose: the compass names people actually use, and fine enough that
 *  a day of riding lands in several petals rather than all in one. */
export const SECTOR_COUNT = 16;
export const SECTOR_DEG = 360 / SECTOR_COUNT;

/**
 * How far off an hour a sample may be and still count. The hourly series covers
 * the local day, so only riding that spills past midnight reaches for this —
 * and an hour either side of the series is still the same weather system.
 */
const HOUR_TOLERANCE_MS = 90 * 60 * 1000;

/**
 * A gap this large between two points is a paused recording, not a stretch of
 * riding: the straight line across it never happened and should not be told
 * which way the wind blew along it. Decimated tracks step ~100 m at a time, so
 * this only ever catches real holes.
 */
const GAP_M = 5000;

/** Wind from within this many degrees of the nose counts as headwind, and the
 *  mirror image as tailwind — the classic thirds, so an aimless day of turning
 *  lands roughly evenly across the three rather than piling into the middle. */
const HEAD_DEG = 60;

export interface Ride {
  points: TrackPoint[];
  hourly: HourlyWind | null | undefined;
}

export interface WindSector {
  /** Middle of the sector, degrees the wind came from. */
  fromDeg: number;
  /** Metres ridden while the wind came from this sector. */
  distanceM: number;
  /** Mean wind speed over those metres, km/h. */
  meanKmh: number;
  /** That distance as a fraction of the strongest sector — the petal's length. */
  share: number;
}

export interface WindAnalysis {
  /** Metres of riding that had both a clock and a wind to match it to. */
  distanceM: number;
  /** How much of the ridden distance that was, 0–1. */
  coverage: number;
  /** Distance-weighted mean wind speed, km/h. */
  windKmh: number;
  /** Strongest gust blowing while the wheels were turning, km/h. */
  gustKmh: number;
  /** Where the wind came from on balance, degrees. */
  windFromDeg: number;
  /** Where the riding went on balance, degrees. */
  travelDeg: number;
  /**
   * Distance-weighted mean of the wind's along-track component: positive is
   * wind in the face, negative is wind at the back. This is the single number
   * the whole feature exists to produce.
   */
  headwindKmh: number;
  /** Distance-weighted mean of the sideways component, always positive. */
  crosswindKmh: number;
  /** The same distance split three ways by angle, metres. */
  headM: number;
  crossM: number;
  tailM: number;
  /** 16 petals, north first, going clockwise. */
  sectors: WindSector[];
}

/** Initial great-circle bearing from `a` to `b`, degrees clockwise from north. */
export function bearingDeg(a: TrackPoint, b: TrackPoint): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return norm360((Math.atan2(y, x) * 180) / Math.PI);
}

export function norm360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** The smaller of the two ways round between two bearings, 0–180. */
export function angleDiffDeg(a: number, b: number): number {
  const d = Math.abs(norm360(a) - norm360(b)) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * The wind at one instant, interpolated between the hours either side.
 *
 * Interpolated as a *vector*, not as two numbers: 350° and 10° average to 0°
 * the vector way and to 180° — the exact opposite — the naive way. The side
 * effect is that a wind swinging hard between two hours comes out slightly
 * slower in the middle, which is physically reasonable and, at cycling
 * timescales, invisible.
 */
export function windAt(
  hourly: HourlyWind,
  timeMs: number,
): { speedKmh: number; fromDeg: number; gustKmh: number | null } | null {
  const t = hourly.time;
  if (t.length === 0) return null;
  if (timeMs < t[0] - HOUR_TOLERANCE_MS) return null;
  if (timeMs > t[t.length - 1] + HOUR_TOLERANCE_MS) return null;

  const step = t.length > 1 ? t[1] - t[0] : 3600000;
  const raw = (timeMs - t[0]) / step;
  const lo = Math.max(0, Math.min(t.length - 1, Math.floor(raw)));
  const hi = Math.max(0, Math.min(t.length - 1, lo + 1));
  const f = lo === hi ? 0 : Math.max(0, Math.min(1, raw - lo));

  const a = vectorAt(hourly, lo);
  const b = vectorAt(hourly, hi);
  // One end missing is not a reason to give up on the sample: the other hour is
  // a better answer than none, and gaps in the series are rare and short.
  if (!a && !b) return null;
  const from = a ?? b!;
  const to = b ?? a!;
  const u = from.u + (to.u - from.u) * f;
  const v = from.v + (to.v - from.v) * f;
  const speedKmh = Math.hypot(u, v);
  const gusts = [hourly.gustKmh[lo], hourly.gustKmh[hi]].filter((g): g is number => g != null);
  return {
    speedKmh,
    // Vector points back towards where the wind came from, so atan2 of it is
    // already the meteorological direction.
    fromDeg: speedKmh === 0 ? from.fromDeg : norm360((Math.atan2(u, v) * 180) / Math.PI),
    gustKmh: gusts.length > 0 ? Math.max(...gusts) : null,
  };
}

function vectorAt(
  hourly: HourlyWind,
  i: number,
): { u: number; v: number; fromDeg: number } | null {
  const s = hourly.speedKmh[i];
  const d = hourly.fromDeg[i];
  if (s == null || d == null) return null;
  const r = (d * Math.PI) / 180;
  return { u: s * Math.sin(r), v: s * Math.cos(r), fromDeg: d };
}

/**
 * Roll up any number of ridden tracks against their days' hourly wind.
 *
 * Takes a list rather than one track so a whole trip is the same call as one
 * day — every figure stays distance-weighted across the lot instead of being an
 * average of averages, which would let a 12 km day shout as loudly as a 140 km
 * one.
 *
 * Returns null when nothing could be matched: no clock on the track, no cached
 * wind, or a day that was all standing still.
 */
export function analyseWind(rides: Ride[]): WindAnalysis | null {
  let totalM = 0;
  let sampledM = 0;
  let sumSpeed = 0;
  let sumHead = 0;
  let sumCross = 0;
  let gustKmh = 0;
  let headM = 0;
  let crossM = 0;
  let tailM = 0;
  // Resultant vectors: sums of unit vectors weighted by distance (and, for the
  // wind, by its strength, so a strong hour steers the mean more than a calm
  // one). Their length is thrown away, only the angle is read back out.
  let travelU = 0;
  let travelV = 0;
  let windU = 0;
  let windV = 0;
  const sectorM = new Array<number>(SECTOR_COUNT).fill(0);
  const sectorSpeed = new Array<number>(SECTOR_COUNT).fill(0);

  for (const ride of rides) {
    const pts = ride.points;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const d = haversineM(a, b);
      if (d === 0 || d > GAP_M) continue;
      totalM += d;

      if (!ride.hourly || a.time === undefined || b.time === undefined) continue;
      const wind = windAt(ride.hourly, (a.time + b.time) / 2);
      if (!wind) continue;

      const travel = bearingDeg(a, b);
      // The angle between where the wind came from and where the bike pointed:
      // 0 is straight in the face, 180 is straight up the back.
      const relative = angleDiffDeg(wind.fromDeg, travel);
      const rad = (relative * Math.PI) / 180;

      sampledM += d;
      sumSpeed += d * wind.speedKmh;
      sumHead += d * wind.speedKmh * Math.cos(rad);
      sumCross += d * wind.speedKmh * Math.abs(Math.sin(rad));
      if (wind.gustKmh != null) gustKmh = Math.max(gustKmh, wind.gustKmh);

      if (relative <= HEAD_DEG) headM += d;
      else if (relative >= 180 - HEAD_DEG) tailM += d;
      else crossM += d;

      const tr = (travel * Math.PI) / 180;
      travelU += d * Math.sin(tr);
      travelV += d * Math.cos(tr);
      const wr = (wind.fromDeg * Math.PI) / 180;
      windU += d * wind.speedKmh * Math.sin(wr);
      windV += d * wind.speedKmh * Math.cos(wr);

      const s = sectorOf(wind.fromDeg);
      sectorM[s] += d;
      sectorSpeed[s] += d * wind.speedKmh;
    }
  }

  if (sampledM === 0) return null;

  const busiest = Math.max(...sectorM);
  return {
    distanceM: sampledM,
    coverage: totalM > 0 ? sampledM / totalM : 0,
    windKmh: sumSpeed / sampledM,
    gustKmh,
    windFromDeg: norm360((Math.atan2(windU, windV) * 180) / Math.PI),
    travelDeg: norm360((Math.atan2(travelU, travelV) * 180) / Math.PI),
    headwindKmh: sumHead / sampledM,
    crosswindKmh: sumCross / sampledM,
    headM,
    crossM,
    tailM,
    sectors: sectorM.map((m, i) => ({
      fromDeg: i * SECTOR_DEG,
      distanceM: m,
      meanKmh: m > 0 ? sectorSpeed[i] / m : 0,
      share: busiest > 0 ? m / busiest : 0,
    })),
  };
}

/** Which petal a direction falls in — sector 0 is centred on north, so it wraps
 *  around 348.75°–11.25° rather than starting at it. */
export function sectorOf(fromDeg: number): number {
  return Math.round(norm360(fromDeg) / SECTOR_DEG) % SECTOR_COUNT;
}

/**
 * Beaufort force from a 10 m wind speed in km/h — the boundaries of the scale
 * itself, which is also what makes it a good colour ramp: its steps are the
 * steps a person outdoors actually notices.
 */
const BEAUFORT_KMH = [1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118];

export function beaufort(kmh: number): number {
  let force = 0;
  for (let i = 0; i < BEAUFORT_KMH.length; i++) if (kmh >= BEAUFORT_KMH[i]) force = i + 1;
  return force;
}

/**
 * The ring's colour ramp, indexed by Beaufort force: the page's own quiet sage
 * for air you would not notice, warming through to a red that means the day was
 * about the wind and nothing else. Not a rainbow — it has to sit next to the
 * day colours on the map without competing with them.
 */
const FORCE_COLORS = [
  "#d9ded6", // 0 calm
  "#c3d0c2", // 1
  "#a8c2a6", // 2
  "#8fb98d", // 3 gentle
  "#d8c46a", // 4 moderate
  "#e0a049", // 5 fresh
  "#d4703a", // 6 strong
  "#c2452f", // 7 near gale
  "#a32b1d", // 8 gale
  "#8f2417", // 9
  "#6e1a11", // 10
  "#54120c", // 11
  "#3a0b07", // 12 hurricane
];

export function windColor(kmh: number): string {
  return FORCE_COLORS[Math.min(beaufort(kmh), FORCE_COLORS.length - 1)];
}

/**
 * How the wind sat overall, as a key into the wording. Thresholds in km/h of
 * *component*, not of wind speed: 8 km/h of headwind is roughly a gear, which
 * is about where a rider stops calling a day neutral.
 */
export type WindVerdict = "headwind" | "tailwind" | "crosswind" | "calm";

export function verdictOf(a: WindAnalysis): WindVerdict {
  if (a.windKmh < 6) return "calm";
  if (a.headwindKmh >= 4) return "headwind";
  if (a.headwindKmh <= -4) return "tailwind";
  if (a.crosswindKmh >= 8) return "crosswind";
  return "calm";
}
