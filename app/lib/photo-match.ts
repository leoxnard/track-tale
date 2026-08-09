import type { TrackPoint } from "./track";

/**
 * Telegram strips EXIF from photos, so we locate a photo on the map by
 * matching its send timestamp to the nearest-in-time track point.
 * Returns null if the day's track has no usable timestamps or the photo
 * was sent far outside the tracked window (e.g. from the hotel hours later).
 */
export function matchPhotoToTrack(
  photoTimeMs: number,
  points: TrackPoint[],
  maxGapMs = 45 * 60 * 1000,
): { lat: number; lng: number } | null {
  let best: TrackPoint | null = null;
  let bestGap = Infinity;
  for (const p of points) {
    if (p.time === undefined) continue;
    const gap = Math.abs(p.time - photoTimeMs);
    if (gap < bestGap) {
      bestGap = gap;
      best = p;
    }
  }
  if (!best || bestGap > maxGapMs) return null;
  return { lat: best.lat, lng: best.lng };
}

/**
 * Same idea across a whole day. A day can hold several segments, so search
 * them as one track and let the globally nearest point win — taking the first
 * segment that happens to match would pin a photo to the morning ride when the
 * afternoon one was closer.
 */
export function matchPhotoToDay(
  photoTimeMs: number,
  segments: TrackPoint[][],
  maxGapMs?: number,
): { lat: number; lng: number } | null {
  return matchPhotoToTrack(photoTimeMs, segments.flat(), maxGapMs);
}
