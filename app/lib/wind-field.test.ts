import { describe, expect, it } from "vitest";
import { haversineM, type TrackPoint } from "./track";
import type { HourlyWeather } from "./weather";
import { driftAt, lodForZoom, windField, LOD_LEVELS } from "./wind-field";

const HOUR = 3600000;
const START = Date.parse("2026-07-14T08:00:00Z");

function steady(speedKmh: number, fromDeg: number): HourlyWeather {
  return {
    time: Array.from({ length: 12 }, (_, i) => START + i * HOUR),
    speedKmh: Array(12).fill(speedKmh),
    fromDeg: Array(12).fill(fromDeg),
    gustKmh: Array(12).fill(speedKmh),
    tempC: Array(12).fill(14),
    precipMm: Array(12).fill(0),
  };
}

/** Twenty kilometres due north, a point every minute. */
function northward(n = 200): TrackPoint[] {
  return Array.from({ length: n }, (_, i) => ({
    lat: 50 + i * 0.001,
    lng: 8,
    time: START + HOUR + i * 60000,
  }));
}

const sitesOf = (hourly: HourlyWeather) => [{ lat: 50, lng: 8, hourly }];

describe("windField", () => {
  it("points the arrows where the wind was going, not where it came from", () => {
    // A northerly blows *towards* the south.
    const [arrow] = windField([{ points: northward(), sites: sitesOf(steady(20, 0)) }]);
    expect(arrow.towardDeg).toBeCloseTo(180, 0);
  });

  it("lays the arrows in lanes either side of the route, never on it", () => {
    const arrows = windField([{ points: northward(), sites: sitesOf(steady(20, 270)) }]);
    const line = { lat: 50.05, lng: 8 };
    // Riding north, so the lanes run east and west of the line — and both sides
    // are used.
    const east = arrows.filter((a) => a.lng > 8);
    const west = arrows.filter((a) => a.lng < 8);
    expect(east.length).toBeGreaterThan(0);
    expect(west.length).toBeGreaterThan(0);
    expect(arrows.some((a) => Math.abs(a.lng - 8) < 1e-9)).toBe(false);
    // The nearest lane is a real buffer away, not a decoration on the line.
    const nearest = Math.min(...arrows.map((a) => haversineM(line, { lat: line.lat, lng: a.lng })));
    expect(nearest).toBeGreaterThan(400);
  });

  it("spaces the arrows along the route rather than per track point", () => {
    // Twenty kilometres at 450 m apart is around forty-five positions, five
    // lanes short of one — not two hundred, which is what the file has points.
    const arrows = windField([{ points: northward(), sites: sitesOf(steady(20, 0)) }]);
    expect(arrows.length).toBeGreaterThan(100);
    expect(arrows.length).toBeLessThan(250);
  });

  it("spreads the detail levels so thinning does not bare one stretch", () => {
    const arrows = windField([{ points: northward(), sites: sitesOf(steady(20, 0)) }]);
    const kept = arrows.filter((a) => a.lod <= 1);
    const north = kept.filter((a) => a.lat > 50.1).length;
    const south = kept.filter((a) => a.lat <= 50.1).length;
    expect(kept.length).toBeGreaterThan(0);
    expect(north).toBeGreaterThan(0);
    expect(south).toBeGreaterThan(0);
  });

  it("colours arrows by the same speed classes the rose uses", () => {
    const calm = windField([{ points: northward(), sites: sitesOf(steady(3, 0)) }]);
    const gale = windField([{ points: northward(), sites: sitesOf(steady(45, 0)) }]);
    expect(calm[0].bin).toBe(0);
    expect(gale[0].bin).toBe(4);
  });

  it("has nothing to draw without wind, a clock or any riding", () => {
    expect(windField([{ points: northward(), sites: [] }])).toEqual([]);
    const timeless = northward().map(({ lat, lng }) => ({ lat, lng }));
    expect(windField([{ points: timeless, sites: sitesOf(steady(20, 0)) }])).toEqual([]);
    expect(windField([])).toEqual([]);
  });

  it("puts the arrows in the same places every time it is asked", () => {
    const ride = { points: northward(), sites: sitesOf(steady(20, 90)) };
    expect(windField([ride])).toEqual(windField([ride]));
  });
});

describe("driftAt", () => {
  const arrow = {
    lat: 50,
    lng: 8,
    towardDeg: 90,
    speedKmh: 20,
    bin: 3,
    lod: 0,
    phase: 0,
  };

  it("carries an arrow along its own direction", () => {
    const start = driftAt(arrow, 0);
    const later = driftAt(arrow, 1600);
    expect(later.lng).toBeGreaterThan(start.lng);
    expect(later.lat).toBeCloseTo(50, 4);
  });

  it("fades to nothing at the moment it snaps back, so the loop is unseen", () => {
    expect(driftAt(arrow, 0).opacity).toBeCloseTo(0, 5);
    expect(driftAt(arrow, 3200).opacity).toBeCloseTo(0, 5);
    expect(driftAt(arrow, 1600).opacity).toBeGreaterThan(0.7);
  });

  it("keeps arrows out of step with each other", () => {
    const other = { ...arrow, phase: 0.5 };
    expect(driftAt(other, 0).opacity).toBeGreaterThan(driftAt(arrow, 0).opacity);
  });
});

describe("lodForZoom", () => {
  it("gives the whole field at street level and a skeleton from far off", () => {
    expect(lodForZoom(15)).toBe(LOD_LEVELS - 1);
    expect(lodForZoom(8)).toBe(0);
    expect(lodForZoom(12)).toBeLessThan(LOD_LEVELS - 1);
    expect(lodForZoom(12)).toBeGreaterThan(lodForZoom(8));
  });
});
