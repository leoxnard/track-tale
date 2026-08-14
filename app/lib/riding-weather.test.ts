import { describe, expect, it } from "vitest";
import type { TrackPoint } from "./track";
import type { HourlyWeather } from "./weather";
import { analyseRidingWeather, hasTemperature, rainAt, tempAt } from "./riding-weather";

const HOUR = 3600000;
/** Midnight, so the hour index is the hour of the day and the tests read plainly. */
const MIDNIGHT = Date.parse("2026-07-14T00:00:00Z");

/**
 * A day of hourly weather. `rain` and `temp` are indexed by hour of the day, and
 * an hour's rain is what fell in the hour *before* its stamp.
 */
function day(rain: number[], temp: number[] = Array(24).fill(15)): HourlyWeather {
  return {
    time: Array.from({ length: 24 }, (_, i) => MIDNIGHT + i * HOUR),
    speedKmh: Array(24).fill(10),
    fromDeg: Array(24).fill(0),
    gustKmh: Array(24).fill(15),
    tempC: temp,
    precipMm: rain,
  };
}

/** A ride of `hours` hours from `startHour`, moving about 20 km/h. */
function ride(startHour: number, hours: number): TrackPoint[] {
  const steps = hours * 6; // a point every ten minutes
  return Array.from({ length: steps + 1 }, (_, i) => ({
    lat: 50 + i * 0.03,
    lng: 8,
    time: MIDNIGHT + startHour * HOUR + i * 10 * 60 * 1000,
  }));
}

const sitesOf = (hourly: HourlyWeather) => [{ lat: 50, lng: 8, hourly }];

describe("rainAt", () => {
  it("puts a moment in the bucket it fell into, not the nearest stamp", () => {
    // 4 mm is stamped at 14:00, meaning it fell between 13:00 and 14:00.
    const rain = Array(24).fill(0);
    rain[14] = 4;
    const h = day(rain);
    expect(rainAt(h, MIDNIGHT + 13 * HOUR + 10 * 60 * 1000)).toBe(4);
    expect(rainAt(h, MIDNIGHT + 13.9 * HOUR)).toBe(4);
    expect(rainAt(h, MIDNIGHT + 14 * HOUR + 10 * 60 * 1000)).toBe(0);
  });

  it("declines to answer well outside the day it has", () => {
    expect(rainAt(day(Array(24).fill(1)), MIDNIGHT - 5 * HOUR)).toBeNull();
  });
});

describe("tempAt", () => {
  it("interpolates, because a temperature is an instant and not a total", () => {
    const temp = Array(24).fill(10);
    temp[12] = 10;
    temp[13] = 20;
    expect(tempAt(day(Array(24).fill(0), temp), MIDNIGHT + 12.5 * HOUR)).toBeCloseTo(15, 5);
  });
});

describe("analyseRidingWeather", () => {
  it("leaves out rain that fell while everyone was asleep", () => {
    // 12 mm overnight, nothing at all during a ride from 10:00 to 14:00.
    const rain = Array(24).fill(0);
    rain[2] = 6;
    rain[3] = 6;
    const a = analyseRidingWeather([{ points: ride(10, 4), sites: sitesOf(day(rain)) }])!;
    expect(a.rainMm).toBe(0);
    expect(a.wetM).toBe(0);
  });

  it("counts the rain that fell on the rider", () => {
    // 3 mm in the hour to 12:00 and 1 mm in the hour to 13:00, riding 10–14.
    const rain = Array(24).fill(0);
    rain[12] = 3;
    rain[13] = 1;
    const a = analyseRidingWeather([{ points: ride(10, 4), sites: sitesOf(day(rain)) }])!;
    expect(a.rainMm).toBeCloseTo(4, 1);
    expect(a.wetM).toBeGreaterThan(0);
  });

  it("shares an hour's rain out by the minutes spent in it", () => {
    // 10 mm in the hour to 12:00, but the ride only covers its second half.
    const rain = Array(24).fill(0);
    rain[12] = 10;
    const a = analyseRidingWeather([{ points: ride(11.5, 0.5), sites: sitesOf(day(rain)) }])!;
    expect(a.rainMm).toBeCloseTo(5, 1);
  });

  it("reports the temperatures the ride was actually out in", () => {
    // Cold before dawn, warm in the afternoon; the ride is 10:00 to 14:00.
    const temp = Array.from({ length: 24 }, (_, i) => (i < 6 ? 3 : i < 10 ? 12 : 20 + i - 10));
    const a = analyseRidingWeather([
      { points: ride(10, 4), sites: sitesOf(day(Array(24).fill(0), temp)) },
    ])!;
    expect(hasTemperature(a)).toBe(true);
    // Never sees the 3°C of the small hours.
    expect(a.tempMinC).toBeGreaterThan(15);
    expect(a.tempMaxC).toBeLessThan(25);
  });

  it("counts the seconds it rode, not the hours in the day", () => {
    const a = analyseRidingWeather([
      { points: ride(9, 3), sites: sitesOf(day(Array(24).fill(0))) },
    ])!;
    expect(a.seconds).toBeCloseTo(3 * 3600, -2);
  });

  it("skips the hole where a recording was paused", () => {
    const points: TrackPoint[] = [
      { lat: 50, lng: 8, time: MIDNIGHT + 10 * HOUR },
      // Two hours later, in the middle of a downpour nobody rode through.
      { lat: 50.3, lng: 8, time: MIDNIGHT + 12 * HOUR },
      { lat: 50.31, lng: 8, time: MIDNIGHT + 12 * HOUR + 600000 },
    ];
    const rain = Array(24).fill(0);
    // 20 mm stamped 13:00 — the hour from 12:00, which is the one the ten
    // minutes after the gap sit in. The two hours of the gap itself are stamped
    // 11:00 and 12:00 and must contribute nothing.
    rain[11] = 20;
    rain[12] = 20;
    rain[13] = 20;
    const a = analyseRidingWeather([{ points, sites: sitesOf(day(rain)) }])!;
    // A sixth of one hour's worth, from the one stretch actually ridden.
    expect(a.rainMm).toBeCloseTo(20 / 6, 1);
  });

  it("copes with a row cached before rain and temperature were fetched", () => {
    // The shape in the database is whatever was written the day it was written,
    // so the arrays can simply be absent however confident the type is.
    const old = { ...day(Array(24).fill(0)) } as HourlyWeather;
    delete (old as Partial<HourlyWeather>).precipMm;
    delete (old as Partial<HourlyWeather>).tempC;
    expect(rainAt(old, MIDNIGHT + 10 * HOUR)).toBeNull();
    expect(tempAt(old, MIDNIGHT + 10 * HOUR)).toBeNull();
    expect(analyseRidingWeather([{ points: ride(10, 2), sites: sitesOf(old) }])).toBeNull();
  });

  it("gives the ride hour by hour, only the hours it was out in", () => {
    const rain = Array(24).fill(0);
    rain[12] = 6;
    const temp = Array.from({ length: 24 }, (_, i) => i);
    const a = analyseRidingWeather([
      { points: ride(10, 3), sites: sitesOf(day(rain, temp)) },
    ])!;
    // 10:00 to 13:00 falls in the buckets stamped 11, 12 and 13.
    expect(a.hours.map((h) => new Date(h.at).getUTCHours())).toEqual([11, 12, 13]);
    expect(a.hours.every((h) => h.seconds > 0)).toBe(true);
    // The rain sits in the hour it fell in, not spread over the ride.
    expect(a.hours.find((h) => new Date(h.at).getUTCHours() === 12)!.rainMm).toBeCloseTo(6, 1);
    expect(a.hours.find((h) => new Date(h.at).getUTCHours() === 11)!.rainMm).toBe(0);
    // Temperatures rise through the morning, as the series says.
    const temps = a.hours.map((h) => h.tempC!);
    expect(temps[0]).toBeLessThan(temps[2]);
  });

  it("means the temperature over time, not over the two extremes", () => {
    // Three hours at 10°C and one at 20°C is 12.5, not 15.
    const temp = Array(24).fill(10);
    temp[13] = 20;
    temp[14] = 20;
    const a = analyseRidingWeather([
      { points: ride(10, 4), sites: sitesOf(day(Array(24).fill(0), temp)) },
    ])!;
    expect(a.tempMeanC).toBeGreaterThan(a.tempMinC);
    expect(a.tempMeanC).toBeLessThan((a.tempMinC + a.tempMaxC) / 2 + 2);
    expect(a.tempMeanC).toBeLessThan(a.tempMaxC);
  });

  it("leaves a hole in the hours where a day was interrupted", () => {
    // Ride 08–10, then nothing until 14, then ride to 15.
    const points = [...ride(8, 2), ...ride(14, 1)];
    const a = analyseRidingWeather([{ points, sites: sitesOf(day(Array(24).fill(0))) }])!;
    const hours = a.hours.map((h) => new Date(h.at).getUTCHours());
    expect(hours).toContain(9);
    expect(hours).toContain(15);
    expect(hours).not.toContain(12);
  });

  it("reads a track whose clock runs backwards the same as one that does not", () => {
    // A reversed route is the same ride written the other way up; it must not
    // cost the day its rain, which is what subtracting the stamps in order did.
    const rain = Array(24).fill(0);
    rain[12] = 4;
    const forwards = ride(10, 3);
    const backwards = [...forwards].reverse();
    const a = analyseRidingWeather([{ points: forwards, sites: sitesOf(day(rain)) }])!;
    const b = analyseRidingWeather([{ points: backwards, sites: sitesOf(day(rain)) }])!;
    expect(b).not.toBeNull();
    expect(b.rainMm).toBeCloseTo(a.rainMm, 5);
    expect(b.seconds).toBeCloseTo(a.seconds, 5);
    expect(b.hours.length).toBe(a.hours.length);
  });

  it("has nothing to say without a clock or without a series", () => {
    const timeless = ride(10, 2).map(({ lat, lng }) => ({ lat, lng }));
    expect(analyseRidingWeather([{ points: timeless, sites: sitesOf(day(Array(24).fill(0))) }])).toBeNull();
    expect(analyseRidingWeather([{ points: ride(10, 2), sites: [] }])).toBeNull();
    expect(analyseRidingWeather([])).toBeNull();
  });
});
