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
 * Everything is summed **in the rider's frame**, not the compass's. The rose
 * was drawn compass-first at the start, and it was wrong in the case that
 * matters most: ride a loop and the mean heading collapses to nothing, so a
 * picture built around "which way was I going" quietly starts answering with
 * noise, while the wind's own direction — the one thing a compass rose shows
 * beautifully — says nothing at all about whether the day was work. Round a
 * lake in a westerly you have a headwind for a quarter of it and a tailwind for
 * a quarter of it, and no arrangement of compass petals will tell you so.
 * Measured from the nose instead, that ride reads exactly as it was ridden. The
 * geographic direction survives as a line of text, where it never needed a
 * picture.
 *
 * Two conventions, both easy to get backwards and both checked by the tests:
 *
 * - Wind direction is meteorological — the direction the wind blows *from*.
 *   A westerly (270°) pushes you east.
 * - The relative angle is measured from the direction of travel round to the
 *   wind's source, clockwise. 0 means the wind comes from exactly where you are
 *   heading: a pure headwind. 90 is from the rider's right, 180 a pure tailwind.
 *
 * Everything here is pure so the family page, the tests and the preview can all
 * run it; the fetching lives in `weather.ts`.
 */

import { haversineM, type TrackPoint } from "./track";
import type { HourlyWind, WindSite } from "./weather";

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

/**
 * How often along the route to ask what the wind was doing.
 *
 * Ten kilometres is roughly the grid of the finest data actually behind the
 * answer — ERA5-Land resolves about 9 km, the short-range forecast models a
 * little finer — so it is the point where asking more often starts returning
 * the same numbers rather than better ones. It is also about the scale a rider
 * notices: over ten kilometres a valley turns, a coast arrives, a forest ends.
 */
const SITE_SPACING_M = 10000;

/**
 * A ceiling, not a target. It only binds on a very long day, and when it does
 * the sites simply spread further apart rather than stopping partway along the
 * route. It exists because every site is a set of hourly readings that has to
 * be stored on the day and shipped to whoever opens the page.
 */
const MAX_SITES = 24;

/**
 * Where along a day's route to ask what the wind was doing.
 *
 * Every ten kilometres, at the middle of each ten-kilometre chunk, so no
 * stretch of the ride is answered by a reading taken beyond the end of it.
 *
 * The site nearest the middle of the day is moved to the front, because the
 * day's temperature, rain and icon are read off whichever site leads the list
 * and the middle is the fairest single answer to "what was the weather that
 * day". The order of the rest does not matter: each stretch of riding looks up
 * the nearest site by distance, not by position in the list.
 */
export function sampleSites(points: TrackPoint[]): TrackPoint[] {
  if (points.length === 0) return [];

  const cumulative: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    cumulative.push(cumulative[i - 1] + haversineM(points[i - 1], points[i]));
  }
  const total = cumulative[cumulative.length - 1];
  const at = (distance: number) => {
    let i = cumulative.findIndex((d) => d >= distance);
    if (i === -1) i = points.length - 1;
    return points[i];
  };

  const count = Math.min(MAX_SITES, Math.max(1, Math.round(total / SITE_SPACING_M)));
  const step = total / count;
  const chosen = Array.from({ length: count }, (_, i) => at((i + 0.5) * step));

  // The middle chunk's site goes first; with an even number of chunks either of
  // the two middle ones is as good an answer as the other.
  const middle = Math.floor((count - 1) / 2);
  return [chosen[middle], ...chosen.filter((_, i) => i !== middle)];
}

export interface Ride {
  points: TrackPoint[];
  /**
   * The wind, at one or more places along this ride. With several, each stretch
   * of riding is answered by whichever site is nearest to it — which is the
   * whole point of asking in more than one place.
   */
  sites: WindSite[];
}

export interface WindSector {
  /**
   * Middle of the sector, in degrees **from the rider's nose**, clockwise: 0 is
   * wind straight in the face, 90 from the right, 180 up the back.
   */
  relativeDeg: number;
  /** Metres ridden while the wind came from this sector. */
  distanceM: number;
  /** Those metres split by speed class — the segments the petal stacks. */
  bins: number[];
  /** Mean wind speed over those metres, km/h. */
  meanKmh: number;
  /** That distance as a fraction of the busiest sector — the petal's length. */
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
  /** Where the wind came from on balance, degrees on the compass. */
  windFromDeg: number;
  /** Where the riding went on balance, degrees on the compass. */
  travelDeg: number;
  /**
   * How much `travelDeg` is worth saying out loud: the length of the mean
   * travel vector over the distance ridden, 0–1.
   *
   * A straight day out is near 1. **A loop is near 0**, and its mean heading is
   * then not a slow answer but a meaningless one — the small asymmetries decide
   * it. Anything that would tell a reader "you rode south-east" has to check
   * this first, or it will confidently make something up about every ride that
   * ended where it started.
   */
  directness: number;
  /** Where the wind sat relative to the nose on balance, 0 ahead, 180 behind. */
  relativeDeg: number;
  /**
   * How much `relativeDeg` is worth drawing, 0–1 — the same guard as
   * `directness`, one level further in.
   *
   * A ride that turned through every heading meets the wind from every angle,
   * and those angles then cancel into a mean that points nowhere in particular.
   * Having just moved the rose into the rider's frame to stop it inventing a
   * direction for a loop, it would be a poor joke to leave an arrow doing it.
   */
  relativeConcentration: number;
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
  /** 16 petals, straight-ahead first, going clockwise round the rider. */
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

/** The site that answers for a stretch of riding: the closest one to it. */
export function nearestSite(sites: WindSite[], at: TrackPoint): WindSite {
  let best = sites[0];
  let bestM = Infinity;
  for (const site of sites) {
    const d = haversineM(site, at);
    if (d < bestM) {
      bestM = d;
      best = site;
    }
  }
  return best;
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
  let noseU = 0;
  let noseV = 0;
  const sectorM = new Array<number>(SECTOR_COUNT).fill(0);
  const sectorSpeed = new Array<number>(SECTOR_COUNT).fill(0);
  const sectorBins = Array.from({ length: SECTOR_COUNT }, () =>
    new Array<number>(SPEED_BINS.length).fill(0),
  );

  for (const ride of rides) {
    const pts = ride.points;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const d = haversineM(a, b);
      if (d === 0 || d > GAP_M) continue;
      totalM += d;

      if (ride.sites.length === 0 || a.time === undefined || b.time === undefined) continue;
      const wind = windAt(nearestSite(ride.sites, a).hourly, (a.time + b.time) / 2);
      if (!wind) continue;

      const travel = bearingDeg(a, b);
      // The angle from the bike's nose round to where the wind came from, and
      // the same angle folded onto 0–180 for the parts that cannot tell left
      // from right. Everything the rose draws is this angle: it is the only
      // frame in which a lap of a lake still says whether the wind was work.
      const bearingToNose = norm360(wind.fromDeg - travel);
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
      const nr = (bearingToNose * Math.PI) / 180;
      noseU += d * wind.speedKmh * Math.sin(nr);
      noseV += d * wind.speedKmh * Math.cos(nr);

      const s = sectorOf(bearingToNose);
      sectorM[s] += d;
      sectorSpeed[s] += d * wind.speedKmh;
      sectorBins[s][binOf(wind.speedKmh)] += d;
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
    directness: Math.hypot(travelU, travelV) / sampledM,
    relativeDeg: norm360((Math.atan2(noseU, noseV) * 180) / Math.PI),
    relativeConcentration: sumSpeed > 0 ? Math.hypot(noseU, noseV) / sumSpeed : 0,
    headwindKmh: sumHead / sampledM,
    crosswindKmh: sumCross / sampledM,
    headM,
    crossM,
    tailM,
    sectors: sectorM.map((m, i) => ({
      relativeDeg: i * SECTOR_DEG,
      distanceM: m,
      bins: sectorBins[i],
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
 * The speed classes the petals stack in, as lower bounds in km/h.
 *
 * A wind rose is a *stacked* chart by convention — each petal is banded by speed
 * class, which is what lets one picture answer both "where from" and "how hard"
 * at once. Colouring a whole petal by its mean was the first attempt and it lost
 * exactly the thing worth seeing: a direction that was mostly calm with one
 * vicious hour in it came out looking identical to one that blew steadily.
 *
 * The boundaries are Beaufort's (force 2, 3, 4 and 5 begin at 6, 12, 20 and
 * 29 km/h), because that scale was built around what a person outdoors notices,
 * and five classes is as many as a petal this size can hold apart.
 */
export const SPEED_BINS = [0, 6, 12, 20, 29];

export function binOf(kmh: number): number {
  let bin = 0;
  for (let i = 0; i < SPEED_BINS.length; i++) if (kmh >= SPEED_BINS[i]) bin = i;
  return bin;
}

/** `<6`, `6–11`, … `29+` — the legend's labels, derived so they cannot drift
 *  out of step with the boundaries they describe. */
export function binLabel(bin: number): string {
  if (bin === 0) return `<${SPEED_BINS[1]}`;
  if (bin === SPEED_BINS.length - 1) return `${SPEED_BINS[bin]}+`;
  return `${SPEED_BINS[bin]}–${SPEED_BINS[bin + 1] - 1}`;
}

/**
 * The ramp, one step per speed class.
 *
 * Sequential, not categorical: lightness falls monotonically (0.92 → 0.80 →
 * 0.69 → 0.54 → 0.38 in OKLab) so the order survives greyscale, a colourblind
 * reader and a bad screen, and the hue warms along with it because a rider
 * reading it expects the hard end to be the red end. The two middle steps sit
 * closer in hue than a categorical palette would allow, which is why the rose
 * never leans on colour alone: the classes are stacked in order from the hub
 * outwards, separated by a hairline of paper, listed in that order in the
 * legend, and spelled out in each petal's tooltip.
 */
export const BIN_COLORS = ["#e2e6dc", "#e6b833", "#e0801f", "#c33320", "#79180f"];

export function windColor(kmh: number): string {
  return BIN_COLORS[binOf(kmh)];
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
