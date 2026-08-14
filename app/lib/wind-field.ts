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
   * Which step along the route this arrow belongs to, counting from the start
   * of the trip. Thinning takes every nth step, so what survives is spread
   * evenly down the whole route rather than dense at the start and bare at the
   * end, and the arrows that survive stay where they were rather than
   * reshuffling as the map moves.
   */
  step: number;
  /** Which lane, -2..2 without 0. Outer lanes go first when the channel closes. */
  lane: number;
  /** 0–1, so a hundred arrows do not drift and fade in lockstep. */
  phase: number;
}

/** How far apart the arrows sit along the route at full detail. */
const STEP_M = 450;
/** Lanes either side of the line, and the gap between them. */
const LANES = 2;
const LANE_GAP_M = 600;
/**
 * How far apart the arrows should sit **on screen**, in CSS pixels.
 *
 * Screen distance rather than ground distance is the whole trick. Thinning by
 * zoom level was the first attempt and it emptied the map exactly when the map
 * was most worth looking at: zoomed out to the whole tour, the arrows were
 * fewer, smaller and no more visible than the paper they sat on. Ground spacing
 * is what should change with the zoom; how the channel *reads* should not.
 */
const TARGET_SPACING_PX = 52;

/**
 * How far apart two lanes must be on screen to be worth drawing as two.
 *
 * Below the first threshold the outer pair sits on top of the inner one; below
 * the second, even the inner pair does, and the channel has become a single
 * file of arrows along the route. Drawing both anyway would stack two arrows on
 * one spot — twice the work for a smudge.
 */
const LANE_LEGIBLE_PX = 7;
const LANE_DISTINCT_PX = 3.5;

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
      // A phase that walks around the cycle with the arrows rather than jumping
      // about: neighbours differ a little, so the channel reads as something
      // moving through it instead of everything blinking at once.
      const phase = (index * 0.137) % 1;
      const step = index;
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
          step,
          lane,
          phase: (phase + Math.abs(lane) * 0.31) % 1,
        });
      }
    }
  }
  return arrows;
}

/**
 * How the channel is thinned at a given scale: take every `stride`th step along
 * the route, and only lanes out to `lanes` either side.
 *
 * Both fall out of one number — how many metres a pixel is worth — so the
 * channel keeps the same look on screen whether it covers a village or a
 * country, and the arrows only ever get further apart on the ground.
 */
export function channelFor(metresPerPixel: number): { stride: number; lanes: number[] } {
  const wanted = (TARGET_SPACING_PX * metresPerPixel) / STEP_M;
  const gapPx = LANE_GAP_M / metresPerPixel;
  return {
    stride: Math.min(400, Math.max(1, Math.round(wanted))),
    // The channel closes as the map pulls back: four lanes, then two, then one
    // file of arrows following the route. It never closes to none.
    lanes: gapPx >= LANE_LEGIBLE_PX ? [-2, -1, 1, 2] : gapPx >= LANE_DISTINCT_PX ? [-1, 1] : [1],
  };
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
  // Peaks well clear of the basemap: at 0.75 the calm classes were a rumour
  // over anything but plain paper.
  return { lat, lng, opacity: Math.sin(Math.PI * t) * 0.9 };
}
