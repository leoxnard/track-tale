/**
 * How long a train fits in the hole a train left, and which bit of it is on
 * screen.
 *
 * The gap in a day's line is as wide as the stretch of route that was skipped,
 * which is anything from a ferry hop to a third of Scotland — and it changes
 * width every time the chart is zoomed. So the train is not a fixed picture
 * but a locomotive plus however many carriages there is room for, worked out
 * in screen pixels at the moment of drawing.
 *
 * The train is hung by its nose, at the point the riding starts again. That
 * anchor is the whole of the design and it took two goes to arrive at. Centred
 * in its gap, the train had to be re-placed and re-lengthened on every frame,
 * so it crawled about inside its own hole as you panned and grew and shrank
 * from the middle out as you zoomed — and when the gap's middle left the
 * window, it vanished outright. Pinned to the far end it does not move
 * relative to the route at all: zooming only ever adds carriages at the back,
 * one at a time, and the edge of the chart cuts through whatever is left.
 *
 * That cut is why nothing here asks whether the train "fits" on screen. It
 * lays the whole train out in the gap and then hands back only the vehicles
 * the window can see, at the positions they would have had anyway. A carriage
 * sliced in half by the chart's edge is the correct picture — the journey
 * carries on past it.
 *
 * Sizes are in CSS pixels and deliberately small: this rides inside a 176 px
 * tall chart and has to read as a train at a glance without becoming the
 * loudest thing on the page.
 */

/**
 * The locomotive is the widest of them because it has the most to say: a
 * boiler, a chimney at the front and a cab at the back are what make it read
 * as a locomotive rather than as a van with windows.
 */
export const LOCO_PX = 32;
/** A ferry and a bus are one shape each, and need less room than that. */
export const VEHICLE_PX = 26;
/**
 * A carriage is longer than the engine that pulls it and no taller than its
 * boiler — that is what real rolling stock looks like, and drawing it stubby
 * made the train read as a toy.
 */
export const CARRIAGE_PX = 24;
/** Air between two vehicles — the coupling, visually. */
export const COUPLING_PX = 3;
/**
 * Breathing room in front of the locomotive, so its buffers do not touch the
 * line where the riding starts again. Kept tight — the train is meant to read
 * as arriving at that point, not as parked near it.
 */
export const TRAIN_PAD_PX = 4;
/** Air between the train and the dashes trailing off behind it. */
export const DASH_CLEARANCE_PX = 5;
/** Locomotive to carriage, or carriage to carriage, front to front. */
const PITCH_PX = CARRIAGE_PX + COUPLING_PX;
/**
 * A hard stop on how many vehicles one gap may put in the DOM. The window
 * already bounds this — a chart is only so many carriages wide — so this is
 * only ever reached if the measurement arrives nonsensical, and it exists so
 * that a bad number cannot lock the page up building rolling stock.
 */
export const MAX_PARTS = 64;

/**
 * How far back from the nose each piece of the train sits, in CSS pixels.
 *
 * Everything downstream is expressed as this one distance, measured backwards
 * along the train from the point it is pinned to, which keeps the arithmetic
 * in one direction and out of the chart's coordinate system entirely.
 */
function backFromNose(carriage: number): { front: number; back: number } {
  // Carriage 0 is the locomotive; carriage n is the nth vehicle behind it.
  if (carriage === 0) return { front: TRAIN_PAD_PX, back: TRAIN_PAD_PX + LOCO_PX };
  const back = TRAIN_PAD_PX + LOCO_PX + carriage * PITCH_PX;
  return { front: back - CARRIAGE_PX, back };
}

/**
 * How many carriages the gap has room for behind the locomotive, or null when
 * not even the locomotive fits — which is the case a bare dashed line is for.
 *
 * Whole carriages only. Half a carriage protruding from the gap would stand on
 * the ridden line next to it, which reads as the train having crashed into the
 * day rather than as the day resuming.
 */
export function carriagesFor(gapPx: number): number | null {
  if (!Number.isFinite(gapPx) || gapPx < TRAIN_PAD_PX + LOCO_PX) return null;
  return Math.floor((gapPx - TRAIN_PAD_PX - LOCO_PX) / PITCH_PX);
}

/** What a whole train of `carriages` measures, nose padding included. */
export function trainLength(carriages: number): number {
  return TRAIN_PAD_PX + LOCO_PX + carriages * PITCH_PX;
}

/** One vehicle to draw, and where its left edge goes. */
export interface Part {
  kind: "engine" | "carriage";
  /** Left edge, in CSS pixels from the left edge of the chart. */
  x: number;
  /** Position along the train, so React can key on something stable. */
  index: number;
}

export interface Train {
  /** Only the vehicles the window can see, nose first. */
  parts: Part[];
  /**
   * What the whole train stands on — including the ones off screen — in the
   * chart's own units, so the dashes know where to stop. Null when no vehicle
   * fits in the gap at all.
   */
  stands: [number, number] | null;
}

/**
 * Lay a vehicle out in a gap and return the part of it that is on screen.
 *
 * `fromX`/`toX` are the ends of the gap and `viewTo` the right-hand edge of
 * the chart, all in the chart's stretched units; `unitsPerPx` converts them to
 * the CSS pixels every vehicle is sized in. The window's left edge is 0.
 *
 * `pulls` is what separates a train, as long as its gap has room for, from a
 * ferry or a bus, which is one shape that either fits or does not.
 */
export function layTrain(
  fromX: number,
  toX: number,
  viewTo: number,
  unitsPerPx: number,
  pulls: boolean,
): Train {
  const empty: Train = { parts: [], stands: null };
  // No measurement yet — on the server, and on the first paint before the
  // resize observer has reported. Dashes only; a guessed width draws a train
  // sized in stretched units, which is wrong on every chart but a 960 px one.
  if (!(unitsPerPx > 0) || !(toX > fromX)) return empty;

  const gapPx = (toX - fromX) / unitsPerPx;
  const single = TRAIN_PAD_PX + (pulls ? LOCO_PX : VEHICLE_PX);
  if (gapPx < single) return empty;

  // Where the nose is pinned, and how much chart there is to its left, both in
  // pixels. `nose` is measured from the chart's left edge and may well be off
  // either side of it — that is the ordinary case once the chart is zoomed.
  const nose = toX / unitsPerPx;
  const viewPx = viewTo / unitsPerPx;
  const carriages = pulls ? carriagesFor(gapPx)! : 0;
  const length = pulls ? trainLength(carriages) : single;

  // Where to start counting. Zoomed deep into the near end of a long crossing
  // the nose is thousands of carriages away off the right of the screen, and
  // walking out to it one coupling at a time is work with nothing to show for
  // it, so the first vehicle that could be on screen is solved for directly.
  const first =
    pulls && nose > viewPx
      ? Math.max(0, Math.floor((nose - viewPx - TRAIN_PAD_PX - LOCO_PX) / PITCH_PX))
      : 0;

  const parts: Part[] = [];
  for (let i = first; i <= carriages && parts.length < MAX_PARTS; i++) {
    const { front, back } = pulls
      ? backFromNose(i)
      : { front: TRAIN_PAD_PX, back: TRAIN_PAD_PX + VEHICLE_PX };
    // Off the left edge: everything further back is too, so stop.
    if (front >= nose) break;
    // Off the right edge. `first` lands just short of the window rather than
    // exactly on it, so this skips the vehicle or two before the edge.
    if (back <= nose - viewPx) continue;
    parts.push({ kind: i === 0 ? "engine" : "carriage", x: nose - back, index: i });
  }

  return {
    parts,
    stands: [toX - (length + DASH_CLEARANCE_PX) * unitsPerPx, toX],
  };
}

/**
 * The stretches of a gap the train does not stand on, as `[from, to]` pairs.
 *
 * A train never fills its gap exactly — there is whatever was left over after
 * the last whole carriage. Left blank that reads as the line simply stopping;
 * dashed, it reads as the journey carrying on past what the train had room to
 * say. With the train pinned to the far end there is normally only the one
 * run, trailing off behind it, but the pair is kept because a vehicle that
 * fills its gap has none and a gap with no vehicle in it is all dash.
 *
 * `stands` is what the vehicle occupies, clearance included, in the same units
 * as `from` and `to`; null for a gap with nothing in it. Runs shorter than
 * `minRun` are dropped — two dashes wedged against a locomotive are dirt, not
 * information.
 */
export function dashRuns(
  from: number,
  to: number,
  stands: [number, number] | null,
  minRun = 3,
): [number, number][] {
  if (!stands) return to - from >= minRun ? [[from, to]] : [];
  return ([
    [from, stands[0]],
    [stands[1], to],
  ] as [number, number][]).filter(([a, b]) => b - a >= minRun);
}

