import { describe, expect, it } from "vitest";
import { photoSites, sitesCovered } from "./photo-sites";
import type { TrackPoint } from "./track";

const NOON = Date.parse("2025-06-01T12:00:00Z");
const HOUR = 3600_000;

/** Roughly a kilometre per 0.009° of latitude, which is close enough here. */
const north = (km: number) => 50 + km * 0.009;

const at = (km: number, hours: number): TrackPoint => ({
  lat: north(km),
  lng: 8,
  time: NOON + hours * HOUR,
});

describe("photo sites", () => {
  it("has nothing to ask about without photos", () => {
    expect(photoSites([])).toEqual([]);
  });

  it("asks once for a morning spent in one place", () => {
    // Five photos within a couple of hundred metres are one weather grid cell.
    const cafe = Array.from({ length: 5 }, (_, i) => ({
      lat: 50 + i * 0.001,
      lng: 8,
      time: NOON + i * HOUR,
    }));
    expect(photoSites(cafe)).toHaveLength(1);
  });

  it("asks again once the day moved somewhere else", () => {
    expect(photoSites([at(0, -3), at(12, 0), at(30, 3)])).toHaveLength(3);
  });

  it("does not treat the photos as a route between them", () => {
    // Two photos 20 km apart. Walked as a track, the sites would land at 5 km
    // and 15 km — two places nobody stood. Each photo is its own site instead.
    const [a, b] = photoSites([at(0, -2), at(20, 2)]);
    expect([a.lat, b.lat].sort()).toEqual([north(0), north(20)]);
  });

  it("leads with the middle of the day, since the temperature is read off it", () => {
    const [first] = photoSites([at(40, 4), at(0, -4), at(20, 0)]);
    expect(first.lat).toBeCloseTo(north(20), 6);
  });

  it("sorts untimed photos last rather than to 1970", () => {
    const undated: TrackPoint = { lat: north(60), lng: 8 };
    const [first] = photoSites([at(0, -2), at(20, 0), at(40, 2), undated]);
    // Four sites, so either middle one will do — but never the undated one.
    expect(first.lat).not.toBeCloseTo(north(60), 6);
  });

  it("keeps a very photographed day inside the site ceiling", () => {
    const epic = Array.from({ length: 100 }, (_, i) => at(i * 15, i));
    const sites = photoSites(epic);
    expect(sites).toHaveLength(24);
    // Thinned across the whole day, not cut off after the first two dozen.
    expect(Math.max(...sites.map((s) => s.lat))).toBeCloseTo(north(99 * 15), 6);
  });
});

describe("sites already asked about", () => {
  it("counts nothing cached as nothing asked", () => {
    expect(sitesCovered([at(0, 0)], [])).toBe(false);
  });

  it("counts a photo beside a cached site as answered", () => {
    expect(sitesCovered([at(1, 0)], [{ lat: north(0), lng: 8 }])).toBe(true);
  });

  it("wants a fresh answer for a photo from somewhere new", () => {
    expect(sitesCovered([at(0, 0), at(40, 2)], [{ lat: north(0), lng: 8 }])).toBe(false);
  });
});
