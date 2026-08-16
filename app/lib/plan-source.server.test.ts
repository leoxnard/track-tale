import { describe, expect, it } from "vitest";
import { decodeOriginal, encodeOriginal } from "./plan-source.server";
import type { TrackPoint } from "./track";

/**
 * The codec only — storing and reading go through Supabase and are not
 * exercised here. What is worth pinning down is that a route survives the round
 * trip unchanged, because the whole point of keeping the original is that it is
 * the original.
 */
describe("plan original codec", () => {
  const route: TrackPoint[] = Array.from({ length: 5000 }, (_, i) => ({
    lat: 50 + Math.sin(i / 40) * 0.002,
    lng: 8 + i * 0.00005,
    alt: 100 + Math.sin(i / 90) * 300,
  }));

  it("gives back every point, on the grid the whole app stores coordinates on", () => {
    const back = decodeOriginal(encodeOriginal(route));
    expect(back).toHaveLength(route.length);
    // Six decimals is eleven centimetres, and it is not this module's choice:
    // it is what `toGeoJson` stores and what the GPX handed to a device is
    // written at. Anything finer would be discarded on the way out anyway. What
    // matters is that no *point* is lost and none is moved on the map.
    back.forEach((point, i) => {
      expect(point.lat).toBeCloseTo(route[i].lat, 6);
      expect(point.lng).toBeCloseTo(route[i].lng, 6);
      expect(point.alt).toBeCloseTo(route[i].alt!, 1);
    });
  });

  it("keeps a route without elevation without inventing any", () => {
    const flat = route.map(({ lat, lng }) => ({ lat, lng }));
    const back = decodeOriginal(encodeOriginal(flat));
    expect(back.every((p) => p.alt === undefined)).toBe(true);
  });

  it("compresses, which is the reason for keeping originals being affordable", () => {
    // A route sampled every few metres is mostly repeated digits. Without this
    // a long tour would be tens of megabytes of JSON in a bucket.
    const raw = Buffer.byteLength(JSON.stringify(route));
    expect(encodeOriginal(route).byteLength).toBeLessThan(raw / 3);
  });

  it("has nothing to store for an empty route", () => {
    expect(decodeOriginal(encodeOriginal([]))).toEqual([]);
  });
});
