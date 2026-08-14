import { describe, expect, it } from "vitest";
import { haversineM, type TrackPoint } from "./track";
import type { HourlyWeather } from "./weather";
import {
  BIN_COLORS,
  analyseWind,
  angleDiffDeg,
  bearingDeg,
  binLabel,
  binOf,
  nearestSite,
  sampleSites,
  sectorOf,
  verdictOf,
  windAt,
  windColor,
} from "./wind";

const HOUR = 3600000;
const START = Date.parse("2026-07-14T06:00:00Z");

/** An hourly series that holds one wind steady all day. */
function steady(speedKmh: number, fromDeg: number, hours = 12): HourlyWeather {
  return {
    time: Array.from({ length: hours }, (_, i) => START + i * HOUR),
    speedKmh: Array(hours).fill(speedKmh),
    fromDeg: Array(hours).fill(fromDeg),
    gustKmh: Array(hours).fill(speedKmh * 1.5),
    tempC: Array(hours).fill(14),
    precipMm: Array(hours).fill(0),
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

/** A ride reads its wind from a list of sites; most tests only need the one. */
function sitesOf(hourly: HourlyWeather | null) {
  return hourly ? [{ lat: 50, lng: 8, hourly }] : [];
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
    const swinging: HourlyWeather = {
      time: [START, START + HOUR],
      speedKmh: [20, 20],
      fromDeg: [350, 10],
      gustKmh: [30, 30],
      tempC: [14, 14],
      precipMm: [0, 0],
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
    const gappy: HourlyWeather = {
      time: [START, START + HOUR],
      speedKmh: [null, 20],
      fromDeg: [null, 90],
      gustKmh: [null, 25],
      tempC: [null, 14],
      precipMm: [null, 0],
    };
    expect(windAt(gappy, START + HOUR / 2)?.fromDeg).toBeCloseTo(90, 5);
  });

  it("gives up when neither end has a reading", () => {
    expect(
      windAt(
        {
          time: [START],
          speedKmh: [null],
          fromDeg: [null],
          gustKmh: [null],
          tempC: [null],
          precipMm: [null],
        },
        START,
      ),
    ).toBeNull();
  });
});

describe("analyseWind", () => {
  it("calls wind from the north a headwind when riding north", () => {
    const a = analyseWind([{ points: NORTHWARD, sites: sitesOf(steady(20, 0)) }])!;
    expect(a.headwindKmh).toBeCloseTo(20, 0);
    expect(a.crosswindKmh).toBeCloseTo(0, 1);
    expect(a.tailM).toBe(0);
    expect(a.headM).toBeGreaterThan(0);
    expect(verdictOf(a)).toBe("headwind");
  });

  it("calls the same wind a tailwind when riding south", () => {
    const south = line({ lat: 50, lng: 8 }, -0.01, 0);
    const a = analyseWind([{ points: south, sites: sitesOf(steady(20, 0)) }])!;
    expect(a.headwindKmh).toBeCloseTo(-20, 0);
    expect(a.headM).toBe(0);
    expect(verdictOf(a)).toBe("tailwind");
  });

  it("splits a wind off the side into crosswind", () => {
    const a = analyseWind([{ points: EASTWARD, sites: sitesOf(steady(20, 0)) }])!;
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
      { points: long, sites: sitesOf(steady(20, 0)) },
      { points: short, sites: sitesOf(steady(20, 0)) },
    ])!;
    expect(a.headwindKmh).toBeGreaterThan(12);
    expect(a.headM).toBeGreaterThan(a.tailM * 5);
  });

  it("puts the wind in the petal at its angle to the rider, not to north", () => {
    // Riding north with the wind out of the south-west: that is wind over the
    // rider's left shoulder, so the petal belongs at 225° round from the nose —
    // and would sit there just the same on a rider heading east in a
    // north-westerly.
    const a = analyseWind([{ points: NORTHWARD, sites: sitesOf(steady(20, 225)) }])!;
    const busiest = a.sectors.reduce((x, y) => (y.distanceM > x.distanceM ? y : x));
    expect(busiest.relativeDeg).toBe(225);
    expect(busiest.share).toBe(1);
    expect(busiest.meanKmh).toBeCloseTo(20, 0);
    expect(a.sectors).toHaveLength(16);
    expect(a.sectors.reduce((s, x) => s + x.distanceM, 0)).toBeCloseTo(a.distanceM, 5);

    const eastward = analyseWind([{ points: EASTWARD, sites: sitesOf(steady(20, 315)) }])!;
    expect(eastward.sectors.reduce((x, y) => (y.distanceM > x.distanceM ? y : x)).relativeDeg).toBe(
      225,
    );
  });

  it("still shows the headwind on a loop, where a compass rose cannot", () => {
    // A square: north, east, south, west, back to the start, in a steady wind
    // out of the north. A quarter of it is straight into the wind and a quarter
    // is pushed along — the fact the whole feature exists to show, and the one
    // a rose drawn around the compass loses entirely, because the ride has no
    // net direction for the bicycle in the middle to point.
    const leg = (from: { lat: number; lng: number }, dLat: number, dLng: number, at: number) =>
      Array.from({ length: 30 }, (_, i) => ({
        lat: from.lat + dLat * i,
        lng: from.lng + dLng * i,
        time: START + at * HOUR + i * 60000,
      }));
    const loop = [
      ...leg({ lat: 50, lng: 8 }, 0.01, 0, 1),
      ...leg({ lat: 50.29, lng: 8 }, 0, 0.0155, 2),
      ...leg({ lat: 50.29, lng: 8.45 }, -0.01, 0, 3),
      ...leg({ lat: 50, lng: 8.45 }, 0, -0.0155, 4),
    ];
    const a = analyseWind([{ points: loop, sites: sitesOf(steady(25, 0, 12)) }])!;

    // The loop comes back to where it started, so its mean heading is noise.
    expect(a.directness).toBeLessThan(0.1);
    // But the four quarters land in four opposite petals all the same.
    expect(a.sectors[0].distanceM).toBeGreaterThan(0); // into the wind
    expect(a.sectors[8].distanceM).toBeGreaterThan(0); // pushed along
    expect(a.headM).toBeGreaterThan(0);
    expect(a.tailM).toBeGreaterThan(0);
    expect(a.headM / a.tailM).toBeCloseTo(1, 0);
    // Head and tail cancel over a lap, which is the honest answer for one.
    expect(Math.abs(a.headwindKmh)).toBeLessThan(2);
  });

  it("knows a straight day had a direction and a steady wind an angle", () => {
    const straight = analyseWind([{ points: NORTHWARD, sites: sitesOf(steady(20, 0)) }])!;
    expect(straight.directness).toBeCloseTo(1, 1);
    expect(straight.relativeConcentration).toBeCloseTo(1, 1);
    expect(straight.relativeDeg).toBeCloseTo(0, 0);
  });

  it("reports the mean direction of travel and of the wind", () => {
    const a = analyseWind([{ points: EASTWARD, sites: sitesOf(steady(20, 270)) }])!;
    expect(a.travelDeg).toBeCloseTo(90, 0);
    expect(a.windFromDeg).toBeCloseTo(270, 0);
  });

  it("ignores the straight line across a paused recording", () => {
    const jumped: TrackPoint[] = [
      { lat: 50, lng: 8, time: START + HOUR },
      { lat: 51, lng: 8, time: START + 2 * HOUR },
    ];
    expect(analyseWind([{ points: jumped, sites: sitesOf(steady(20, 0)) }])).toBeNull();
  });

  it("reports how much of the riding it could actually answer for", () => {
    const half = analyseWind([
      { points: NORTHWARD, sites: sitesOf(steady(20, 0)) },
      { points: line({ lat: 40, lng: 8 }, 0.01, 0), sites: sitesOf(null) },
    ])!;
    expect(half.coverage).toBeCloseTo(0.5, 1);
    expect(analyseWind([{ points: NORTHWARD, sites: sitesOf(steady(20, 0)) }])!.coverage).toBe(1);
  });

  it("has nothing to say without a clock, a wind or any movement", () => {
    const timeless = NORTHWARD.map(({ lat, lng }) => ({ lat, lng }));
    expect(analyseWind([{ points: timeless, sites: sitesOf(steady(20, 0)) }])).toBeNull();
    expect(analyseWind([{ points: NORTHWARD, sites: sitesOf(null) }])).toBeNull();
    expect(analyseWind([])).toBeNull();
    expect(
      analyseWind([
        {
          points: [
            { lat: 50, lng: 8, time: START + HOUR },
            { lat: 50, lng: 8, time: START + HOUR + 60000 },
          ],
          sites: sitesOf(steady(20, 0)),
        },
      ]),
    ).toBeNull();
  });

  it("keeps a calm day out of the verdicts", () => {
    const a = analyseWind([{ points: NORTHWARD, sites: sitesOf(steady(3, 0)) }])!;
    expect(verdictOf(a)).toBe("calm");
  });
});

describe("sampling the route", () => {
  /** Metres between the first and last point of a straight line of them. */
  const lengthOf = (points: TrackPoint[]) => haversineM(points[0], points[points.length - 1]);

  it("asks about every ten kilometres of riding", () => {
    // ~1 km: one site. Asking twice would be asking the same grid cell twice.
    expect(sampleSites(line({ lat: 50, lng: 8 }, 0.001, 0, 10))).toHaveLength(1);
    // ~111 km of riding, so around eleven sites.
    const day = line({ lat: 50, lng: 8 }, 0.01, 0, 101);
    expect(lengthOf(day) / 1000).toBeCloseTo(111, -1);
    expect(sampleSites(day)).toHaveLength(11);
  });

  it("spreads wider rather than stopping short on an enormous day", () => {
    // ~440 km would be 44 sites at ten-kilometre spacing; capped at 24, they
    // must still cover the whole route rather than the first 240 km of it.
    const epic = line({ lat: 45, lng: 8 }, 0.04, 0, 100);
    const sites = sampleSites(epic);
    expect(sites).toHaveLength(24);
    const north = Math.max(...sites.map((s) => s.lat));
    const south = Math.min(...sites.map((s) => s.lat));
    expect(north).toBeGreaterThan(epic[epic.length - 1].lat - 0.5);
    expect(south).toBeLessThan(epic[0].lat + 0.5);
  });

  it("leads with the middle, since the day's temperature is read off it", () => {
    const day = line({ lat: 45, lng: 8 }, 0.01, 0, 101);
    const [first] = sampleSites(day);
    const middle = day[Math.floor(day.length / 2)];
    expect(Math.abs(first.lat - middle.lat)).toBeLessThan(0.1);
  });

  it("has nothing to sample on an empty track", () => {
    expect(sampleSites([])).toEqual([]);
  });

  it("gives a standing-still day the one site it needs", () => {
    const parked = [
      { lat: 50, lng: 8, time: START },
      { lat: 50, lng: 8, time: START + HOUR },
    ];
    expect(sampleSites(parked)).toHaveLength(1);
  });
});

describe("several sites along one day", () => {
  it("answers each stretch with the wind nearest to it", () => {
    // Headwind in the south, tailwind in the north, riding north through both.
    // One site would have called the whole day one or the other.
    // Long series: this "ride" takes 17 hours, and a wind that ran out at hour
    // 12 would drop the northern half and fake a headwind day.
    const south = { lat: 50, lng: 8, hourly: steady(20, 0, 24) };
    const north = { lat: 52, lng: 8, hourly: steady(20, 180, 24) };
    const ride = line({ lat: 50, lng: 8 }, 0.02, 0, 100);
    const a = analyseWind([{ points: ride, sites: [south, north] }])!;
    expect(a.headM).toBeGreaterThan(0);
    expect(a.tailM).toBeGreaterThan(0);
    // Symmetrical setup, so the two halves should very nearly cancel.
    expect(Math.abs(a.headwindKmh)).toBeLessThan(4);
    expect(nearestSite([south, north], { lat: 51.9, lng: 8 })).toBe(north);
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
    const gusty: HourlyWeather = {
      time: Array.from({ length: 12 }, (_, i) => START + i * HOUR),
      speedKmh: Array.from({ length: 12 }, (_, i) => (i < 6 ? 25 : 8)),
      fromDeg: Array(12).fill(0),
      gustKmh: Array(12).fill(40),
      tempC: Array(12).fill(9),
      precipMm: Array(12).fill(0),
    };
    const long = line({ lat: 50, lng: 8 }, 0.01, 0, 40);
    const north = analyseWind([{ points: long, sites: sitesOf(gusty) }])!.sectors[0];
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
