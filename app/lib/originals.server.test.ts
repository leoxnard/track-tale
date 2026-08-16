import { describe, expect, it } from "vitest";
import { decodeOriginal, encodeOriginal } from "./originals.server";
import type { TrackPoint } from "./track";

/**
 * The codec only — storing and reading go through Supabase and are not
 * exercised here. What is worth pinning down is that a line survives the round
 * trip unchanged, whether it was planned or ridden, because the whole point of
 * keeping the original is that it is the original.
 */
describe("original codec", () => {
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

  it("keeps the clock on a recording, which is what makes it a ride", () => {
    // A plan has no timestamps and a ride is nothing without them: the moving
    // time, the weather over the riding hours and every photo pinned by time
    // all read them back off a line like this one.
    const start = Date.parse("2026-06-01T07:00:00Z");
    const ridden = route.map((p, i) => ({ ...p, time: start + i * 1000 }));
    const back = decodeOriginal(encodeOriginal(ridden));
    expect(back.map((p) => p.time)).toEqual(ridden.map((p) => p.time));
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
