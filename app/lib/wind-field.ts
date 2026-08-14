/**
 * The wind laid out on the map: a channel of arrows along the route, each one
 * pointing the way the wind was blowing there, at the hour it was ridden.
 *
 * The rose answers "was the day work". This answers "where". A day whose rose
 * says half headwind is often a day with one exposed valley in it, and the only
 * way to see that is on the map, over the ground it happened on.
 *
 * The arrows sit in lanes either side of the line rather than on it, because on
 * it they would bury the day's own colour under a row of chevrons — the route is
 * the subject and the wind is the weather around it. The lane spacing is in
 * metres, so the channel is a real buffer on the ground and narrows to the line
 * as you zoom out, rather than a fixed-width ribbon that means nothing.
 *
 * Two directions to keep straight. The wind's own convention says where it comes
 * *from*; an arrow has to point where it is *going*, so `towardDeg` is the
 * reverse of everything in `wind.ts`. And the lanes are laid out perpendicular
 * to the direction of travel, so a hairpin's lanes cross — accepted, since the
 * alternative is a buffer that ignores which way the road ran.
 */

import { haversineM, type TrackPoint } from "./track";
import { bearingDeg, binOf, nearestSite, norm360, windAt, type Ride } from "./wind";

export interface WindArrow {
  lng: number;
  lat: number;
  /** Degrees clockwise from north the wind blew *towards* — where the arrow points. */
  towardDeg: number;
  speedKmh: number;
  /** Which speed class, for the colour it shares with the rose's petals. */
  bin: number;
  /**
   * Detail level, 0 first. Zoom out and the higher levels drop away, which
   * thins the channel evenly instead of leaving one dense stretch and one bare
   * one. Cheaper than rebuilding the field on every zoom, and it keeps the
   * arrows that survive in the same places rather than reshuffling them.
   */
  lod: number;
  /** 0–1, so a hundred arrows do not drift and fade in lockstep. */
  phase: number;
}

/** How far apart the arrows sit along the route at full detail. */
const STEP_M = 450;
/** Lanes either side of the line, and the gap between them. */
const LANES = 2;
const LANE_GAP_M = 600;
/** How many detail levels the thinning has to work with. */
export const LOD_LEVELS = 8;

/** Metres to degrees, near enough at the scale of a lane's width. */
function offsetPoint(p: TrackPoint, bearing: number, metres: number): { lat: number; lng: number } {
  const rad = (bearing * Math.PI) / 180;
  const north = Math.cos(rad) * metres;
  const east = Math.sin(rad) * metres;
  return {
    lat: p.lat + north / 111320,
    lng: p.lng + east / (111320 * Math.cos((p.lat * Math.PI) / 180)),
  };
}

/**
 * Build the field for any number of rides.
 *
 * Deterministic, including the phases: the arrows must land in the same places
 * on every render, or toggling the overlay would reshuffle the whole channel.
 */
export function windField(rides: Ride[]): WindArrow[] {
  const arrows: WindArrow[] = [];
  let sinceLast = STEP_M; // so the first point of a ride gets an arrow
  let index = 0;

  for (const ride of rides) {
    if (ride.sites.length === 0) continue;
    const pts = ride.points;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      sinceLast += haversineM(a, b);
      if (sinceLast < STEP_M) continue;
      sinceLast = 0;
      if (a.time === undefined) continue;

      const wind = windAt(nearestSite(ride.sites, a).hourly, a.time);
      if (!wind || wind.speedKmh <= 0) continue;

      const travel = bearingDeg(a, b);
      const towardDeg = norm360(wind.fromDeg + 180);
      const bin = binOf(wind.speedKmh);
      const lod = index % LOD_LEVELS;
      // A phase that walks around the cycle with the arrows rather than jumping
      // about: neighbours differ a little, so the channel reads as something
      // moving through it instead of everything blinking at once.
      const phase = (index * 0.137) % 1;
      index++;

      for (let lane = -LANES; lane <= LANES; lane++) {
        if (lane === 0) continue; // the line itself belongs to the day's colour
        const { lat, lng } = offsetPoint(a, travel + 90, lane * LANE_GAP_M);
        arrows.push({
          lat,
          lng,
          towardDeg,
          speedKmh: wind.speedKmh,
          bin,
          // The outer lanes go first when the channel thins, so what is left
          // hugs the route.
          lod: Math.max(lod, (Math.abs(lane) - 1) * 4),
          phase: (phase + Math.abs(lane) * 0.31) % 1,
        });
      }
    }
  }
  return arrows;
}

/** How much of the field to draw at a zoom level: everything at street level,
 *  a thinned skeleton when the whole tour is on screen. */
export function lodForZoom(zoom: number): number {
  if (zoom >= 13) return LOD_LEVELS - 1;
  if (zoom >= 11.5) return 3;
  if (zoom >= 10) return 1;
  return 0;
}

/**
 * Where an arrow is, and how visible it is, at one moment of the drift.
 *
 * Each arrow slides a short way along its own direction and fades out as it
 * goes, restarting from nothing — so the reset is never seen, which is the only
 * hard part of making a loop of this kind look like weather rather than a
 * carousel.
 */
export function driftAt(
  arrow: WindArrow,
  nowMs: number,
  cycleMs = 3200,
  driftM = 260,
): { lat: number; lng: number; opacity: number } {
  const t = ((nowMs / cycleMs + arrow.phase) % 1 + 1) % 1;
  const { lat, lng } = offsetPoint(arrow, arrow.towardDeg, t * driftM);
  return { lat, lng, opacity: Math.sin(Math.PI * t) * 0.75 };
}
