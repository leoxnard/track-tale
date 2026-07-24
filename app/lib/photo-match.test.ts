import { describe, expect, it } from "vitest";
import { matchPhotoToTrack } from "./photo-match";
import type { TrackPoint } from "./track";

const t0 = Date.parse("2026-08-01T08:00:00Z");
const HOUR = 3_600_000;
const MINUTE = 60_000;

const points: TrackPoint[] = [
  { lat: 48.1, lng: 11.5, time: t0 },
  { lat: 48.2, lng: 11.6, time: t0 + HOUR },
  { lat: 48.3, lng: 11.7, time: t0 + 2 * HOUR },
];

describe("matchPhotoToTrack", () => {
  it("pins a photo to the nearest point in time", () => {
    expect(matchPhotoToTrack(t0 + HOUR - 100_000, points)).toEqual({ lat: 48.2, lng: 11.6 });
  });

  it("matches a photo taken exactly at a track point", () => {
    expect(matchPhotoToTrack(t0 + 2 * HOUR, points)).toEqual({ lat: 48.3, lng: 11.7 });
  });

  it("accepts a photo just inside the window", () => {
    expect(matchPhotoToTrack(t0 - 44 * MINUTE, points)).toEqual({ lat: 48.1, lng: 11.5 });
  });

  it("gives up on a photo sent from the hotel hours later", () => {
    expect(matchPhotoToTrack(t0 + 2 * HOUR + 46 * MINUTE, points)).toBeNull();
  });

  it("returns null when the track has no timestamps", () => {
    expect(matchPhotoToTrack(t0, [{ lat: 48.1, lng: 11.5 }])).toBeNull();
  });

  it("returns null for an empty track", () => {
    expect(matchPhotoToTrack(t0, [])).toBeNull();
  });

  it("ignores untimed points while still matching timed ones", () => {
    const mixed: TrackPoint[] = [{ lat: 47, lng: 10 }, ...points];
    expect(matchPhotoToTrack(t0, mixed)).toEqual({ lat: 48.1, lng: 11.5 });
  });

  it("respects a caller-supplied window", () => {
    expect(matchPhotoToTrack(t0 - 10 * MINUTE, points, 5 * MINUTE)).toBeNull();
    expect(matchPhotoToTrack(t0 - 10 * MINUTE, points, 20 * MINUTE)).toEqual({
      lat: 48.1,
      lng: 11.5,
    });
  });
});
