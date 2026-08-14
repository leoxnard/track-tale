import { describe, expect, it } from "vitest";
import { haversineM, type TrackPoint } from "./track";
import type { HourlyWeather } from "./weather";
import { channelFor, driftAt, windField } from "./wind-field";

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

  it("numbers the steps along the route so thinning cannot bare one end", () => {
    const arrows = windField([{ points: northward(), sites: sitesOf(steady(20, 0)) }]);
    // Take every fourth step, the way a zoomed-out map does.
    const kept = arrows.filter((a) => a.step % 4 === 0);
    expect(kept.filter((a) => a.lat > 50.1).length).toBeGreaterThan(0);
    expect(kept.filter((a) => a.lat <= 50.1).length).toBeGreaterThan(0);
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
    step: 0,
    lane: 1,
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
    expect(driftAt(arrow, 1600).opacity).toBeGreaterThan(0.85);
  });

  it("keeps arrows out of step with each other", () => {
    const other = { ...arrow, phase: 0.5 };
    expect(driftAt(other, 0).opacity).toBeGreaterThan(driftAt(arrow, 0).opacity);
  });
});

describe("channelFor", () => {
  it("keeps the same look on screen by spreading the arrows on the ground", () => {
    // Close in, every step is drawn and the channel is its full width.
    const near = channelFor(2);
    expect(near.stride).toBe(1);
    expect(near.lanes).toEqual([-2, -1, 1, 2]);
    // A whole tour on screen: the same arrows, kilometres apart instead of
    // hundreds of metres — thinned, never emptied.
    const far = channelFor(300);
    expect(far.stride).toBeGreaterThan(20);
    expect(far.lanes).toEqual([1]);
  });

  it("never thins to nothing, however far out the map goes", () => {
    for (const mpp of [1, 10, 100, 1000, 20000]) {
      const { stride, lanes } = channelFor(mpp);
      expect(stride).toBeGreaterThanOrEqual(1);
      expect(Number.isFinite(stride)).toBe(true);
      expect(lanes.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("closes the channel a lane at a time instead of stacking arrows", () => {
    expect(channelFor(50).lanes).toHaveLength(4);
    expect(channelFor(120).lanes).toEqual([-1, 1]);
    // Far enough out that even the inner pair would overlap: one file, not two
    // arrows on the same pixel.
    expect(channelFor(300).lanes).toEqual([1]);
  });
});
