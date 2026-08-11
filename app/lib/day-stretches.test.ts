import { describe, expect, it } from "vitest";
import { riddenStretches, toPieces } from "./day-stretches";
import { toGeoJson, type TrackPoint } from "./track";

/** A ride of `count` points starting at a latitude, climbing as it goes. */
const leg = (fromLat: number, count = 20): TrackPoint[] =>
  Array.from({ length: count }, (_, i) => ({
    lat: fromLat + i * 0.001,
    lng: 0,
    alt: 100 + i * 5,
  }));

const segment = (points: TrackPoint[], distanceM: number, sport: string | null) => ({
  geojson: toGeoJson(points),
  distance_m: distanceM,
  sport,
});

describe("riddenStretches", () => {
  it("is one stretch for a day ridden straight through", () => {
    const stretches = riddenStretches([
      segment(leg(0), 40_000, "touringbicycle"),
      segment(leg(0.019), 30_000, "touringbicycle"),
    ]);

    expect(stretches).toHaveLength(1);
    expect(stretches[0].distanceM).toBe(70_000);
  });

  it("splits where the day resumed somewhere else, and drops what carried it", () => {
    const stretches = riddenStretches([
      segment(leg(0), 86_000, "touringbicycle"),
      // The train covers the ground between; it is not riding and not distance.
      segment([{ lat: 0.02, lng: 0 }, { lat: 1.2, lng: 0 }], 133_000, "train"),
      segment(leg(1.2), 11_000, "touringbicycle"),
    ]);

    expect(stretches.map((s) => s.distanceM)).toEqual([86_000, 11_000]);
    expect(stretches[0].points[0].lat).toBeCloseTo(0, 5);
    expect(stretches[1].points[0].lat).toBeCloseTo(1.2, 5);
  });

  it("has nothing for a day that was only travelled", () => {
    expect(riddenStretches([segment(leg(0), 133_000, "train")])).toEqual([]);
  });
});

describe("toPieces", () => {
  it("gives each stretch its own axis, starting at zero", () => {
    const pieces = toPieces(
      riddenStretches([
        segment(leg(0), 86_000, "touringbicycle"),
        segment([{ lat: 0.02, lng: 0 }, { lat: 1.2, lng: 0 }], 133_000, "train"),
        segment(leg(1.2), 11_000, "touringbicycle"),
      ]),
    );

    expect(pieces).toHaveLength(2);
    for (const piece of pieces) {
      expect(piece.profile[0].d).toBe(0);
      // Each measures itself, not the ground between them.
      expect(piece.profile[piece.profile.length - 1].d).toBeLessThan(5000);
    }
    expect(pieces.map((p) => p.distanceM)).toEqual([86_000, 11_000]);
  });
});
