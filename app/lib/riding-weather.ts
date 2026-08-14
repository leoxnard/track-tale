/**
 * The rain and the temperature the rider was actually out in.
 *
 * The day card used to read its numbers off the daily summary: the calendar
 * day's rainfall total and its min/max temperature, at one point near the route.
 * Both are answers to a question nobody asked. Eight millimetres that fell
 * between two and five in the morning is a dry day on a bicycle. A minimum of
 * 4°C reached at dawn is not the temperature of a ride that started at ten.
 *
 * So the same hourly series the wind rose already fetches — every 10 km along
 * the route, one request — is walked along the track instead, and only the hours
 * the wheels were turning count. What comes out is what the rider met.
 *
 * The two quantities are not handled alike, and that is the part worth getting
 * right. Temperature is an instant: interpolating between two hours is exactly
 * correct. Rain is an accumulation over the hour *before* its stamp, so it has
 * no value "between" two hours to interpolate — a moment simply falls inside one
 * bucket, and what matters is the fraction of that bucket spent riding.
 */

import { haversineM } from "./track";
import type { HourlyWeather } from "./weather";
import { nearestSite, type Ride } from "./wind";

/**
 * A gap longer than this between two points is not riding, it is a recording
 * left running through lunch or a hole in the file. Counting it would hand the
 * rider every millimetre that fell while the bike was against a wall.
 */
const GAP_MS = 20 * 60 * 1000;

/** Below this hourly rate nothing is falling that anyone would call rain. */
const RAINING_MM_H = 0.15;

export interface RidingWeather {
  /** Millimetres that fell while riding. */
  rainMm: number;
  /** Metres ridden while it was raining. */
  wetM: number;
  /** Coldest and warmest it was out there, °C. */
  tempMinC: number;
  tempMaxC: number;
  /** Seconds of riding these figures cover. */
  seconds: number;
  /** How much of the ridden distance had both a clock and an hourly series. */
  coverage: number;
}

/**
 * Rain rate at one moment, mm per hour.
 *
 * Picks the bucket the moment falls *into* — the first hour stamped at or after
 * it — rather than the nearest stamp. An hour labelled 14:00 holds 13:00–14:00,
 * so a rider at 13:10 is in it and a rider at 14:10 is not.
 */
export function rainAt(hourly: HourlyWeather, timeMs: number): number | null {
  const t = hourly.time;
  // Rows cached before rain was fetched have no `precipMm` at all, whatever the
  // type says about it — the shape in the database is whatever was written the
  // day it was written. Same for temperature below. `/refreshweather` fills
  // them in; until it runs, a day simply has no rain figure.
  if (t.length === 0 || !hourly.precipMm) return null;
  const step = t.length > 1 ? t[1] - t[0] : 3600000;
  // One step of slack at either end: the series covers the local day, and a ride
  // that began just before midnight is still the same weather.
  if (timeMs < t[0] - step || timeMs > t[t.length - 1] + step) return null;
  const i = t.findIndex((stamp) => stamp >= timeMs);
  return hourly.precipMm[i === -1 ? t.length - 1 : i] ?? null;
}

/** Temperature at one moment, interpolated between the hours either side. */
export function tempAt(hourly: HourlyWeather, timeMs: number): number | null {
  const t = hourly.time;
  if (t.length === 0 || !hourly.tempC) return null;
  const step = t.length > 1 ? t[1] - t[0] : 3600000;
  if (timeMs < t[0] - step || timeMs > t[t.length - 1] + step) return null;
  const raw = (timeMs - t[0]) / step;
  const lo = Math.max(0, Math.min(t.length - 1, Math.floor(raw)));
  const hi = Math.max(0, Math.min(t.length - 1, lo + 1));
  const a = hourly.tempC[lo];
  const b = hourly.tempC[hi];
  if (a == null && b == null) return null;
  if (a == null || b == null) return (a ?? b)!;
  const f = lo === hi ? 0 : Math.max(0, Math.min(1, raw - lo));
  return a + (b - a) * f;
}

/**
 * Roll up the rain and temperature over the riding itself.
 *
 * Takes the same rides the wind rose does, so a day and a whole trip are the
 * same call, and each stretch is answered by the sample site nearest to it.
 * Returns null when nothing could be matched — no clock on the track, or no
 * hourly series cached for the day.
 */
export function analyseRidingWeather(rides: Ride[]): RidingWeather | null {
  let rainMm = 0;
  let wetM = 0;
  let seconds = 0;
  let sampledM = 0;
  let totalM = 0;
  let tempMinC = Infinity;
  let tempMaxC = -Infinity;
  let sawTemp = false;

  for (const ride of rides) {
    const pts = ride.points;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const d = haversineM(a, b);
      totalM += d;
      if (ride.sites.length === 0 || a.time === undefined || b.time === undefined) continue;
      const dt = b.time - a.time;
      if (dt <= 0 || dt > GAP_MS) continue;

      const hourly = nearestSite(ride.sites, a).hourly;
      const middle = a.time + dt / 2;

      const rate = rainAt(hourly, middle);
      if (rate !== null) {
        // Only the slice of the hour spent here, so a shower is shared out
        // between the riders' minutes in it rather than counted whole.
        rainMm += rate * (dt / 3600000);
        if (rate >= RAINING_MM_H) wetM += d;
      }

      const temp = tempAt(hourly, middle);
      if (temp !== null) {
        tempMinC = Math.min(tempMinC, temp);
        tempMaxC = Math.max(tempMaxC, temp);
        sawTemp = true;
      }

      if (rate !== null || temp !== null) {
        seconds += dt / 1000;
        sampledM += d;
      }
    }
  }

  if (seconds === 0) return null;
  return {
    rainMm,
    wetM,
    tempMinC: sawTemp ? tempMinC : NaN,
    tempMaxC: sawTemp ? tempMaxC : NaN,
    seconds,
    coverage: totalM > 0 ? sampledM / totalM : 0,
  };
}

/** Whether the temperatures came out usable — the day card falls back if not. */
export function hasTemperature(riding: RidingWeather): boolean {
  return Number.isFinite(riding.tempMinC) && Number.isFinite(riding.tempMaxC);
}
