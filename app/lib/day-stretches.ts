/**
 * A day's riding, as the stretches it was actually ridden in.
 *
 * Three places need this and used to do it three ways: the family page, the
 * share card and the archive. They all start from the same rows — a day's
 * track segments, some of which were travelled rather than ridden — and all
 * have to answer the same two questions: what was pedalled, and where did it
 * stop and start again.
 */

import { buildProfile, fromGeoJson, groupContinuous, type TrackGeoJson, type TrackPoint } from "./track";
import { isTransit } from "./transport";
import type { TourPiece } from "./tour-layout";

/** The columns any of this needs off a `track_segments` row. */
export interface StoredSegment {
  geojson: unknown;
  distance_m: number;
  sport: string | null;
}

export interface Stretch {
  /** Authoritative distance, from the segments' own stats. */
  distanceM: number;
  points: TrackPoint[];
}

/**
 * The ridden segments of a day, grouped into stretches with no break in them.
 *
 * Travelled legs are dropped rather than joined: a train is not riding, and
 * the ground it covered was not covered by the traveller.
 */
export function riddenStretches(segments: StoredSegment[]): Stretch[] {
  const ridden = segments.filter((s) => !isTransit(s.sport));
  const points = ridden.map((s) => fromGeoJson(s.geojson as TrackGeoJson));
  return groupContinuous(points).map((group) => ({
    distanceM: group.reduce((sum, i) => sum + ridden[i].distance_m, 0),
    points: group.flatMap((i) => points[i]),
  }));
}

/** Those stretches as the tour layout wants them, each on its own axis. */
export function toPieces(stretches: Stretch[]): TourPiece[] {
  return stretches.map((stretch) => ({
    distanceM: stretch.distanceM,
    profile: buildProfile(stretch.points),
  }));
}
