import { describe, expect, it } from "vitest";
import type { TrackPoint } from "./track";
import type { HourlyWind } from "./weather";
import {
  BIN_COLORS,
  analyseWind,
  angleDiffDeg,
  bearingDeg,
  binLabel,
  binOf,
  sectorOf,
  verdictOf,
  windAt,
  windColor,
} from "./wind";

const HOUR = 3600000;
const START = Date.parse("2026-07-14T06:00:00Z");

/** An hourly series that holds one wind steady all day. */
function steady(speedKmh: number, fromDeg: number, hours = 12): HourlyWind {
  return {
    time: Array.from({ length: hours }, (_, i) => START + i * HOUR),
    speedKmh: Array(hours).fill(speedKmh),
    fromDeg: Array(hours).fill(fromDeg),
    gustKmh: Array(hours).fill(speedKmh * 1.5),
  };
}

/** A straight line of points from a start, one every ten minutes. */
function line(
  from: { lat: number; lng: number },
  dLat: number,
  dLng: number,
  n = 7,
): TrackPoint[] {
  return Array.from({ length: n }, (_, i) => ({
    lat: from.lat + dLat * i,
    lng: from.lng + dLng * i,
    time: START + HOUR + i * 10 * 60 * 1000,
  }));
}

const NORTHWARD = line({ lat: 50, lng: 8 }, 0.01, 0);
const EASTWARD = line({ lat: 50, lng: 8 }, 0, 0.01);

describe("bearingDeg", () => {
  it("reads north, east, south and west off the compass", () => {
    const here = { lat: 50, lng: 8 };
    expect(bearingDeg(here, { lat: 51, lng: 8 })).toBeCloseTo(0, 1);
    expect(bearingDeg(here, { lat: 49, lng: 8 })).toBeCloseTo(180, 1);
    // Due east is the *initial* bearing of a great circle that then curves
    // north of the parallel, so over a whole degree of longitude at this
    // latitude it reads a few tenths under 90 — as it should.
    expect(bearingDeg(here, { lat: 50, lng: 9 })).toBeCloseTo(90, 0);
    expect(bearingDeg(here, { lat: 50, lng: 8.001 })).toBeCloseTo(90, 2);
    expect(bearingDeg(here, { lat: 50, lng: 7 })).toBeCloseTo(270, 0);
  });
});

describe("angleDiffDeg", () => {
  it("takes the short way round the circle", () => {
    expect(angleDiffDeg(350, 10)).toBe(20);
    expect(angleDiffDeg(10, 350)).toBe(20);
    expect(angleDiffDeg(0, 180)).toBe(180);
    expect(angleDiffDeg(-10, 10)).toBe(20);
  });
});

describe("windAt", () => {
  it("interpolates the wind vector rather than the two numbers", () => {
    // 350° and 10° must meet at north, not at south — the whole reason the
    // interpolation is done on components.
    const swinging: HourlyWind = {
      time: [START, START + HOUR],
      speedKmh: [20, 20],
      fromDeg: [350, 10],
      gustKmh: [30, 30],
    };
    const mid = windAt(swinging, START + HOUR / 2)!;
    expect(mid.fromDeg).toBeCloseTo(0, 1);
    expect(mid.speedKmh).toBeGreaterThan(19);
  });

  it("reaches a little past the ends of the series but not far", () => {
    const h = steady(15, 180, 3);
    expect(windAt(h, START - 30 * 60 * 1000)?.speedKmh).toBeCloseTo(15, 5);
    expect(windAt(h, START - 5 * HOUR)).toBeNull();
  });

  it("falls back to the neighbouring hour when one end is missing", () => {
    const gappy: HourlyWind = {
      time: [START, START + HOUR],
      speedKmh: [null, 20],
      fromDeg: [null, 90],
      gustKmh: [null, 25],
    };
    expect(windAt(gappy, START + HOUR / 2)?.fromDeg).toBeCloseTo(90, 5);
  });

  it("gives up when neither end has a reading", () => {
    expect(
      windAt({ time: [START], speedKmh: [null], fromDeg: [null], gustKmh: [null] }, START),
    ).toBeNull();
  });
});

describe("analyseWind", () => {
  it("calls wind from the north a headwind when riding north", () => {
    const a = analyseWind([{ points: NORTHWARD, hourly: steady(20, 0) }])!;
    expect(a.headwindKmh).toBeCloseTo(20, 0);
    expect(a.crosswindKmh).toBeCloseTo(0, 1);
    expect(a.tailM).toBe(0);
    expect(a.headM).toBeGreaterThan(0);
    expect(verdictOf(a)).toBe("headwind");
  });

  it("calls the same wind a tailwind when riding south", () => {
    const south = line({ lat: 50, lng: 8 }, -0.01, 0);
    const a = analyseWind([{ points: south, hourly: steady(20, 0) }])!;
    expect(a.headwindKmh).toBeCloseTo(-20, 0);
    expect(a.headM).toBe(0);
    expect(verdictOf(a)).toBe("tailwind");
  });

  it("splits a wind off the side into crosswind", () => {
    const a = analyseWind([{ points: EASTWARD, hourly: steady(20, 0) }])!;
    expect(a.headwindKmh).toBeCloseTo(0, 1);
    expect(a.crosswindKmh).toBeCloseTo(20, 0);
    expect(a.crossM).toBeGreaterThan(0);
    expect(verdictOf(a)).toBe("crosswind");
  });

  it("weights by distance, so the long leg decides the average", () => {
    // Ten kilometres into the wind and one kilometre out of it must not average
    // to nothing.
    const long = line({ lat: 50, lng: 8 }, 0.02, 0, 11);
    const short = line({ lat: 40, lng: 8 }, -0.02, 0, 2);
    const a = analyseWind([
      { points: long, hourly: steady(20, 0) },
      { points: short, hourly: steady(20, 0) },
    ])!;
    expect(a.headwindKmh).toBeGreaterThan(12);
    expect(a.headM).toBeGreaterThan(a.tailM * 5);
  });

  it("puts the wind in the petal it came from and colours it by strength", () => {
    const a = analyseWind([{ points: NORTHWARD, hourly: steady(20, 225) }])!;
    const busiest = a.sectors.reduce((x, y) => (y.distanceM > x.distanceM ? y : x));
    expect(busiest.fromDeg).toBe(225);
    expect(busiest.share).toBe(1);
    expect(busiest.meanKmh).toBeCloseTo(20, 0);
    expect(a.sectors).toHaveLength(16);
    expect(a.sectors.reduce((s, x) => s + x.distanceM, 0)).toBeCloseTo(a.distanceM, 5);
  });

  it("reports the mean direction of travel and of the wind", () => {
    const a = analyseWind([{ points: EASTWARD, hourly: steady(20, 270) }])!;
    expect(a.travelDeg).toBeCloseTo(90, 0);
    expect(a.windFromDeg).toBeCloseTo(270, 0);
  });

  it("ignores the straight line across a paused recording", () => {
    const jumped: TrackPoint[] = [
      { lat: 50, lng: 8, time: START + HOUR },
      { lat: 51, lng: 8, time: START + 2 * HOUR },
    ];
    expect(analyseWind([{ points: jumped, hourly: steady(20, 0) }])).toBeNull();
  });

  it("reports how much of the riding it could actually answer for", () => {
    const half = analyseWind([
      { points: NORTHWARD, hourly: steady(20, 0) },
      { points: line({ lat: 40, lng: 8 }, 0.01, 0), hourly: null },
    ])!;
    expect(half.coverage).toBeCloseTo(0.5, 1);
    expect(analyseWind([{ points: NORTHWARD, hourly: steady(20, 0) }])!.coverage).toBe(1);
  });

  it("has nothing to say without a clock, a wind or any movement", () => {
    const timeless = NORTHWARD.map(({ lat, lng }) => ({ lat, lng }));
    expect(analyseWind([{ points: timeless, hourly: steady(20, 0) }])).toBeNull();
    expect(analyseWind([{ points: NORTHWARD, hourly: null }])).toBeNull();
    expect(analyseWind([])).toBeNull();
    expect(
      analyseWind([
        {
          points: [
            { lat: 50, lng: 8, time: START + HOUR },
            { lat: 50, lng: 8, time: START + HOUR + 60000 },
          ],
          hourly: steady(20, 0),
        },
      ]),
    ).toBeNull();
  });

  it("keeps a calm day out of the verdicts", () => {
    const a = analyseWind([{ points: NORTHWARD, hourly: steady(3, 0) }])!;
    expect(verdictOf(a)).toBe("calm");
  });
});

describe("the speed classes", () => {
  it("bins on the Beaufort boundaries the legend promises", () => {
    expect(binOf(0)).toBe(0);
    expect(binOf(5.9)).toBe(0);
    expect(binOf(6)).toBe(1);
    expect(binOf(19)).toBe(2);
    expect(binOf(20)).toBe(3);
    expect(binOf(29)).toBe(4);
    expect(binOf(200)).toBe(4);
  });

  it("labels each class from the same boundaries, so the two cannot drift", () => {
    expect(binLabel(0)).toBe("<6");
    expect(binLabel(1)).toBe("6–11");
    expect(binLabel(2)).toBe("12–19");
    expect(binLabel(3)).toBe("20–28");
    expect(binLabel(4)).toBe("29+");
  });

  it("gives every speed a colour, however silly", () => {
    for (const kmh of [0, 7, 25, 60, 140, 400]) {
      expect(windColor(kmh)).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(BIN_COLORS).toHaveLength(5);
  });

  it("splits a petal's distance across the classes it was ridden in", () => {
    // Half the day in a fresh breeze, half in a gentle one, all from the north.
    const gusty: HourlyWind = {
      time: Array.from({ length: 12 }, (_, i) => START + i * HOUR),
      speedKmh: Array.from({ length: 12 }, (_, i) => (i < 6 ? 25 : 8)),
      fromDeg: Array(12).fill(0),
      gustKmh: Array(12).fill(40),
    };
    const long = line({ lat: 50, lng: 8 }, 0.01, 0, 40);
    const north = analyseWind([{ points: long, hourly: gusty }])!.sectors[0];
    expect(north.bins[3]).toBeGreaterThan(0);
    expect(north.bins[1]).toBeGreaterThan(0);
    expect(north.bins.reduce((s, v) => s + v, 0)).toBeCloseTo(north.distanceM, 5);
  });
});

describe("sectorOf", () => {
  it("centres the first petal on north instead of starting it there", () => {
    expect(sectorOf(0)).toBe(0);
    expect(sectorOf(355)).toBe(0);
    expect(sectorOf(11)).toBe(0);
    expect(sectorOf(12)).toBe(1);
    expect(sectorOf(90)).toBe(4);
    expect(sectorOf(-90)).toBe(12);
  });
});
