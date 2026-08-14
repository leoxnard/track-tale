import { describe, expect, it } from "vitest";
import { haversineM, type TrackPoint } from "./track";
import type { HourlyWeather } from "./weather";
import { channelFor, detailAlpha, placeArrow, windField } from "./wind-field";

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

  it("keeps the samples on the route and works the lanes out later", () => {
    // Riding due north up the meridian: the samples are *on* it. Where the
    // arrows go is a question for the zoom, not for the field.
    const samples = windField([{ points: northward(), sites: sitesOf(steady(20, 270)) }]);
    expect(samples.every((s) => Math.abs(s.lng - 8) < 1e-9)).toBe(true);
    expect(samples[0].travelDeg).toBeCloseTo(0, 0);
  });

  it("puts the lanes square to the riding, a screen-width apart either side", () => {
    const [sample] = windField([{ points: northward(), sites: sitesOf(steady(20, 270)) }]);
    const channel = channelFor(10);
    const placed = channel.lanes.map((lane) => placeArrow(sample, lane, channel, 0));
    // Riding north, so the lanes run east and west of the line — both sides used.
    expect(placed.some((p) => p.lng > 8)).toBe(true);
    expect(placed.some((p) => p.lng < 8)).toBe(true);
    // The outer lane sits a full buffer out; at ten metres a pixel that is a
    // centimetre of screen, not a fixed distance on the ground.
    const outer = placeArrow(sample, 2, channel, 0);
    expect(haversineM({ lat: sample.lat, lng: sample.lng }, outer)).toBeCloseTo(
      channel.laneGapM * 2,
      -1,
    );
  });

  it("spaces the samples along the route rather than per track point", () => {
    // Twenty kilometres at 450 m apart is around forty-five samples, not the
    // two hundred points the file has.
    const samples = windField([{ points: northward(), sites: sitesOf(steady(20, 0)) }]);
    expect(samples.length).toBeGreaterThan(30);
    expect(samples.length).toBeLessThan(60);
  });

  it("numbers the steps along the route so thinning cannot bare one end", () => {
    const samples = windField([{ points: northward(), sites: sitesOf(steady(20, 0)) }]);
    const kept = samples.filter((a) => a.step % 4 === 0);
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

describe("placeArrow", () => {
  const sample = {
    lat: 50,
    lng: 8,
    travelDeg: 0,
    towardDeg: 90,
    speedKmh: 20,
    bin: 3,
    step: 0,
    phase: 0,
  };
  const channel = channelFor(10);

  it("carries an arrow along the wind's own direction", () => {
    const start = placeArrow(sample, 1, channel, 0);
    const later = placeArrow(sample, 1, channel, 1600);
    expect(later.lng).toBeGreaterThan(start.lng);
    expect(later.lat).toBeCloseTo(50, 4);
  });

  it("fades to nothing at the moment it snaps back, so the loop is unseen", () => {
    expect(placeArrow(sample, 1, channel, 0).opacity).toBeCloseTo(0, 5);
    expect(placeArrow(sample, 1, channel, 3200).opacity).toBeCloseTo(0, 5);
    expect(placeArrow(sample, 1, channel, 1600).opacity).toBeGreaterThan(0.95);
  });

  it("keeps arrows out of step with each other", () => {
    const other = { ...sample, phase: 0.5 };
    expect(placeArrow(other, 1, channel, 0).opacity).toBeGreaterThan(
      placeArrow(sample, 1, channel, 0).opacity,
    );
  });
});

describe("detailAlpha", () => {
  const at = (step: number, mpp: number) =>
    detailAlpha({ step } as never, channelFor(mpp));

  it("fades the in-between arrows instead of switching them on and off", () => {
    // Find a scale partway between two levels, where the halfway arrows should
    // be halfway visible.
    let partway = 0;
    for (let mpp = 1; mpp < 400; mpp += 0.5) {
      const c = channelFor(mpp);
      if (c.blend > 0.4 && c.blend < 0.6) {
        partway = mpp;
        break;
      }
    }
    expect(partway).toBeGreaterThan(0);
    const c = channelFor(partway);
    // The arrows that survive to the next level out stay solid …
    expect(at(0, partway)).toBe(1);
    expect(at(c.coarse, partway)).toBe(1);
    // … and the ones between them are on their way out, not gone.
    const between = at(c.fine, partway);
    expect(between).toBeGreaterThan(0.2);
    expect(between).toBeLessThan(0.8);
  });

  it("nests the levels, so zooming only ever adds arrows between the others", () => {
    const near = channelFor(4);
    const far = channelFor(64);
    const shown = (c: ReturnType<typeof channelFor>) =>
      Array.from({ length: 400 }, (_, i) => i).filter((step) => detailAlpha({ step } as never, c) > 0);
    // Every arrow visible from far out is still visible close in.
    for (const step of shown(far)) expect(shown(near)).toContain(step);
  });
});

describe("channelFor", () => {
  it("holds the buffer at about a centimetre of screen at any scale", () => {
    // Half a centimetre between lanes, so the outer pair is a centimetre out.
    for (const mpp of [1, 10, 100, 1000]) {
      const c = channelFor(mpp);
      const outerCm = ((c.laneGapM * 2) / mpp / (96 / 2.54));
      expect(outerCm).toBeCloseTo(1, 5);
    }
  });

  it("spreads the arrows on the ground to keep them steady on screen", () => {
    // Close in every sample is drawn; with a whole tour on screen they are
    // kilometres apart — the same picture, over more ground.
    expect(channelFor(2).coarse).toBeLessThanOrEqual(2);
    expect(channelFor(400).coarse * 450).toBeGreaterThan(10_000);
  });

  it("keeps all four lanes, however far out the map goes", () => {
    for (const mpp of [1, 10, 100, 1000, 20000]) {
      const c = channelFor(mpp);
      expect(c.lanes).toEqual([-2, -1, 1, 2]);
      expect(Number.isFinite(c.coarse)).toBe(true);
      expect(c.coarse).toBeGreaterThanOrEqual(1);
      expect(c.laneGapM).toBeGreaterThan(0);
    }
  });
});
