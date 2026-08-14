/**
 * The wind laid out on the map: a channel of arrows along the route, each one
 * pointing the way the wind was blowing there, at the hour it was ridden.
 *
 * The rose answers "was the day work". This answers "where". A day whose rose
 * says half headwind is often a day with one exposed valley in it, and the only
 * way to see that is on the map, over the ground it happened on.
 *
 * **Nothing here is positioned on the ground.** What is stored is a list of
 * samples *on the route* — a place, a moment, a wind — and the channel around
 * them is laid out fresh every frame from one number: how many metres a pixel is
 * currently worth. The lanes therefore sit about a centimetre either side of the
 * line whatever the zoom, which is kilometres of ground with a whole tour on
 * screen and a few hundred metres in a valley. Baking the lanes into the field
 * at a fixed width in metres was the first attempt, and it meant the channel was
 * either a wide smear or a hairline depending on how far out you happened to be,
 * with a visible jump each time a lane was dropped to cope.
 *
 * The density along the route is handled the same way and, more importantly,
 * **fades between levels rather than switching**. Zoom in and the arrows halfway
 * between the ones already there fade up into place; zoom out and they fade
 * away again. A hard stride would pop a whole alternating set in and out at one
 * pixel of zoom, which is the thing that makes an overlay look broken.
 *
 * Two directions to keep straight. The wind's own convention says where it comes
 * *from*; an arrow has to point where it is *going*, so `towardDeg` is the
 * reverse of everything in `wind.ts`. And the lanes are laid out perpendicular
 * to the direction of travel, so a hairpin's lanes cross — accepted, since the
 * alternative is a buffer that ignores which way the road ran.
 */

import { haversineM, type TrackPoint } from "./track";
import { bearingDeg, binOf, nearestSite, norm360, windAt, type Ride } from "./wind";

/** One place on the route, with the wind that was over it at the time. */
export interface WindSample {
  /** On the route itself. The lanes are worked out from here at draw time. */
  lng: number;
  lat: number;
  /** Which way the riding was going here — the axis the lanes are square to. */
  travelDeg: number;
  /** Degrees clockwise from north the wind blew *towards* — where an arrow points. */
  towardDeg: number;
  speedKmh: number;
  /** Which speed class, for the colour it shares with the rose's petals. */
  bin: number;
  /**
   * Which step along the route this is, counting from the start of the trip.
   * The thinning keeps steps divisible by a power of two, so what survives is
   * spread evenly down the whole route, and — because the sets nest — zooming
   * in only ever *adds* arrows between the ones already on screen.
   */
  step: number;
  /** 0–1, so a hundred arrows do not drift and fade in lockstep. */
  phase: number;
}

/** How far apart the samples sit along the route at full detail. */
const STEP_M = 450;

/** CSS pixels per centimetre at the CSS reference resolution. */
const PX_PER_CM = 96 / 2.54;

/**
 * The channel's half-width and the gap between arrows, both on screen.
 *
 * A centimetre of buffer is wide enough to read as a channel around the route
 * rather than decoration on it, and narrow enough that it still belongs to the
 * line at a glance. The along-route gap is a little wider than the lane gap so
 * the channel reads as flowing rather than as a grid.
 */
const BUFFER_CM = 1;
const SPACING_CM = 1.15;
/** Lanes either side; the outer pair sits at the full buffer width. */
const LANES = [-2, -1, 1, 2];

/** Metres to degrees, near enough at the scale of a lane's width. */
function offsetPoint(
  p: { lat: number; lng: number },
  bearing: number,
  metres: number,
): { lat: number; lng: number } {
  const rad = (bearing * Math.PI) / 180;
  const north = Math.cos(rad) * metres;
  const east = Math.sin(rad) * metres;
  return {
    lat: p.lat + north / 111320,
    lng: p.lng + east / (111320 * Math.cos((p.lat * Math.PI) / 180)),
  };
}

/**
 * Build the samples for any number of rides.
 *
 * Deterministic, including the phases: the samples must land in the same places
 * on every render, or toggling the overlay would reshuffle the whole channel.
 */
export function windField(rides: Ride[]): WindSample[] {
  const samples: WindSample[] = [];
  let sinceLast = STEP_M; // so the first point of a ride gets a sample
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

      samples.push({
        lat: a.lat,
        lng: a.lng,
        travelDeg: bearingDeg(a, b),
        towardDeg: norm360(wind.fromDeg + 180),
        speedKmh: wind.speedKmh,
        bin: binOf(wind.speedKmh),
        step: index,
        // A phase that walks around the cycle with the samples rather than
        // jumping about: neighbours differ a little, so the channel reads as
        // something moving through it instead of everything blinking at once.
        phase: (index * 0.137) % 1,
      });
      index++;
    }
  }
  return samples;
}

export interface Channel {
  /** Ground distance between lanes, so the channel is a constant width on screen. */
  laneGapM: number;
  /** The lanes to draw, inner pair first. */
  lanes: number[];
  /** Samples on this stride are fully drawn. Always a power of two. */
  coarse: number;
  /** Samples on this stride are the in-between ones, fading by `blend`. */
  fine: number;
  /** 0 when the fine set is fully in, 1 when it has faded out entirely. */
  blend: number;
}

/**
 * How to lay the channel out at a given scale.
 *
 * Everything falls out of metres-per-pixel, so the channel looks the same
 * whether it covers a village or a country: about a centimetre of buffer, about
 * a centimetre between arrows, and the arrows themselves kilometres apart on the
 * ground when the whole tour is on screen.
 *
 * The two strides are powers of two so their sets nest — every arrow of the
 * coarse set is also in the fine set — which is what lets one fade into the
 * other without anything jumping sideways.
 */
export function channelFor(metresPerPixel: number): Channel {
  const wantedSteps = Math.max(1, (SPACING_CM * PX_PER_CM * metresPerPixel) / STEP_M);
  const level = Math.log2(wantedSteps);
  const floor = Math.max(0, Math.floor(level));
  return {
    laneGapM: (BUFFER_CM / 2) * PX_PER_CM * metresPerPixel,
    lanes: LANES,
    coarse: 2 ** (floor + 1),
    fine: 2 ** floor,
    blend: Math.max(0, Math.min(1, level - floor)),
  };
}

/**
 * How visible one sample is at this level of detail: full for the arrows that
 * survive to the next level out, fading for the ones that will not.
 */
export function detailAlpha(sample: WindSample, channel: Channel): number {
  if (sample.step % channel.coarse === 0) return 1;
  if (sample.step % channel.fine === 0) return 1 - channel.blend;
  return 0;
}

/**
 * Where one arrow of one sample is, and how visible, at this moment.
 *
 * The lane offset is applied first — square to the direction of travel — and the
 * drift along the wind on top of it. Each arrow slides a short way and fades out
 * as it goes, restarting from nothing, so the reset is never seen: that is the
 * only hard part of making a loop of this kind look like weather rather than a
 * carousel.
 */
export function placeArrow(
  sample: WindSample,
  lane: number,
  channel: Channel,
  nowMs: number,
  cycleMs = 3200,
): { lat: number; lng: number; opacity: number } {
  const t = (((nowMs / cycleMs + sample.phase) % 1) + 1) % 1;
  const lanePoint = offsetPoint(sample, sample.travelDeg + 90, lane * channel.laneGapM);
  // Drift scales with the channel too, so an arrow always travels about the same
  // distance across the screen however far out the map is.
  const drift = channel.laneGapM * 1.6;
  const { lat, lng } = offsetPoint(lanePoint, sample.towardDeg, t * drift);
  return { lat, lng, opacity: Math.sin(Math.PI * t) * detailAlpha(sample, channel) };
}
