import { describe, expect, it } from "vitest";
import {
  DAY_COLORS,
  buildProfile,
  computeStats,
  dayColor,
  decimate,
  fromGeoJson,
  haversineM,
  sortSegmentsByStart,
  toGeoJson,
  type TrackPoint,
} from "./track";

const t0 = Date.parse("2026-08-01T06:00:00Z");
const at = (lat: number, lng: number, extra: Partial<TrackPoint> = {}): TrackPoint => ({
  lat,
  lng,
  ...extra,
});
/** A straight northward line, one point every ~111 m. */
const ramp = (count: number, alt?: (i: number) => number): TrackPoint[] =>
  Array.from({ length: count }, (_, i) =>
    at(i * 0.001, 0, alt ? { alt: alt(i) } : {}),
  );

describe("haversineM", () => {
  it("measures a degree of latitude as ~111.2 km", () => {
    expect(haversineM(at(0, 0), at(1, 0))).toBeCloseTo(111194.9, 0);
  });

  it("shrinks a degree of longitude by the cosine of the latitude", () => {
    const equator = haversineM(at(0, 0), at(0, 1));
    const north = haversineM(at(60, 0), at(60, 1));
    expect(north / equator).toBeCloseTo(Math.cos((60 * Math.PI) / 180), 3);
  });

  it("is zero for a point against itself", () => {
    expect(haversineM(at(48.137, 11.576), at(48.137, 11.576))).toBe(0);
  });
});

describe("computeStats", () => {
  it("ignores altitude noise below the hysteresis threshold", () => {
    // A barometer wobbling by a metre must not add up to a mountain.
    const points = [100, 101, 100, 101, 100].map((alt, i) => at(i * 0.001, 0, { alt }));
    const stats = computeStats(points);
    expect(stats.elevationUp).toBe(0);
    expect(stats.elevationDown).toBe(0);
  });

  it("counts a sustained climb once, from the anchor", () => {
    const stats = computeStats([100, 101, 102, 103].map((alt, i) => at(i * 0.001, 0, { alt })));
    expect(stats.elevationUp).toBe(3);
    expect(stats.elevationDown).toBe(0);
  });

  it("counts a sustained descent", () => {
    const stats = computeStats([100, 99, 98, 97].map((alt, i) => at(i * 0.001, 0, { alt })));
    expect(stats.elevationDown).toBe(3);
    expect(stats.elevationUp).toBe(0);
  });

  it("excludes a long stop from moving time but not from duration", () => {
    const points = [
      at(0, 0, { time: t0 }),
      at(0.001, 0, { time: t0 + 10_000 }), // ~111 m in 10 s — riding
      at(0.001001, 0, { time: t0 + 1_010_000 }), // ~0.1 m in 1000 s — a long lunch
    ];
    const stats = computeStats(points);
    expect(stats.movingS).toBe(10);
    expect(stats.durationS).toBe(1010);
  });

  it("reports the first timestamp as the start", () => {
    const stats = computeStats([at(0, 0), at(0.001, 0, { time: t0 }), at(0.002, 0, { time: t0 + 5000 })]);
    expect(stats.startedAt).toBe("2026-08-01T06:00:00.000Z");
  });

  it("leaves the start unset when nothing is timestamped", () => {
    const stats = computeStats(ramp(3));
    expect(stats.startedAt).toBeUndefined();
    expect(stats.durationS).toBe(0);
    expect(stats.distanceM).toBeGreaterThan(0);
  });
});

describe("toGeoJson / fromGeoJson", () => {
  it("round-trips a track within storage rounding", () => {
    const points = [
      at(48.137154, 11.576124, { alt: 519.4, time: t0 }),
      at(48.138001, 11.577999, { alt: 522.1, time: t0 + 5000 }),
    ];
    const back = fromGeoJson(toGeoJson(points));
    expect(back).toHaveLength(2);
    back.forEach((p, i) => {
      expect(p.lat).toBeCloseTo(points[i].lat, 5);
      expect(p.lng).toBeCloseTo(points[i].lng, 5);
      expect(p.alt).toBeCloseTo(points[i].alt!, 1);
      expect(p.time).toBe(points[i].time);
    });
  });

  it("brings missing altitude and time back as undefined, not null", () => {
    const back = fromGeoJson(toGeoJson([at(1, 2), at(3, 4)]));
    expect(back[0].alt).toBeUndefined();
    expect(back[0].time).toBeUndefined();
  });

  it("stores coordinates as [lng, lat]", () => {
    const geojson = toGeoJson([at(48.1, 11.5)]);
    expect(geojson.geometry.coordinates[0]).toEqual([11.5, 48.1]);
  });
});

describe("decimate", () => {
  it("keeps the first and last point when thinning", () => {
    const points = ramp(5000);
    const out = decimate(points, 2000);
    expect(out.length).toBeLessThanOrEqual(2001);
    expect(out[0]).toBe(points[0]);
    expect(out[out.length - 1]).toBe(points[4999]);
  });

  it("leaves a short track untouched", () => {
    const points = ramp(10);
    expect(decimate(points, 2000)).toBe(points);
  });
});

describe("buildProfile", () => {
  it("needs two altitude samples to draw anything", () => {
    expect(buildProfile(ramp(5))).toEqual([]);
    expect(buildProfile([at(0, 0, { alt: 100 }), at(0.001, 0)])).toEqual([]);
  });

  it("measures from the start and ends at the full distance", () => {
    const points = ramp(50, (i) => 100 + i);
    const profile = buildProfile(points);
    const total = points
      .slice(1)
      .reduce((sum, p, i) => sum + haversineM(points[i], p), 0);

    expect(profile[0].d).toBe(0);
    expect(profile[profile.length - 1].d).toBe(Math.round(total));
    for (let i = 1; i < profile.length; i++) {
      expect(profile[i].d).toBeGreaterThan(profile[i - 1].d);
    }
  });

  it("smooths without ever leaving the raw altitude range", () => {
    const alts = [100, 140, 100, 140, 100, 140, 100, 140, 100, 140];
    const profile = buildProfile(alts.map((alt, i) => at(i * 0.001, 0, { alt })));
    for (const p of profile) {
      expect(p.e).toBeGreaterThanOrEqual(100);
      expect(p.e).toBeLessThanOrEqual(140);
    }
  });

  it("caps how many points it returns", () => {
    const profile = buildProfile(ramp(5000, (i) => 100 + (i % 50)), 240);
    expect(profile.length).toBeLessThanOrEqual(241);
    expect(profile.length).toBeGreaterThan(200);
  });

  it("carries coordinates so the chart can drive the map marker", () => {
    const profile = buildProfile(ramp(20, (i) => 100 + i));
    expect(profile[0].lat).toBeCloseTo(0, 5);
    expect(profile[0].lng).toBeCloseTo(0, 5);
  });
});

describe("sortSegmentsByStart", () => {
  it("puts a day's split activities back in order", () => {
    const segments = [
      { startedAt: "2026-08-01T14:00:00Z", label: "afternoon" },
      { startedAt: "2026-08-01T08:00:00Z", label: "morning" },
    ];
    expect(sortSegmentsByStart(segments).map((s) => s.label)).toEqual(["morning", "afternoon"]);
  });

  it("sorts undated segments first rather than dropping them", () => {
    const segments = [
      { startedAt: "2026-08-01T08:00:00Z", label: "morning" },
      { startedAt: undefined, label: "unknown" },
    ];
    expect(sortSegmentsByStart(segments).map((s) => s.label)).toEqual(["unknown", "morning"]);
  });
});

describe("dayColor", () => {
  it("cycles so a long trip never runs out", () => {
    expect(dayColor(1)).toBe(DAY_COLORS[0]);
    expect(dayColor(DAY_COLORS.length)).toBe(DAY_COLORS[DAY_COLORS.length - 1]);
    expect(dayColor(DAY_COLORS.length + 1)).toBe(DAY_COLORS[0]);
  });
});
