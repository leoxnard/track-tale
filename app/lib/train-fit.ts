/**
 * How long a train fits in the hole a train left.
 *
 * The gap in a day's line is as wide as the stretch of route that was skipped,
 * which is anything from a ferry hop to a third of Scotland — and it changes
 * width every time the chart is zoomed. So the train is not a fixed picture
 * but a locomotive plus however many carriages there is room for, worked out
 * in screen pixels at the moment of drawing.
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
 * Breathing room at both ends, so the train never touches the ridden lines.
 * Kept tight: every pixel here is a pixel the train cannot use, and it was
 * costing a phone-width gap the one carriage that does fit in it.
 */
export const TRAIN_PAD_PX = 4;
/**
 * A cap on the carriage count. A long ride zoomed right in would otherwise
 * grow a train of hundreds of DOM nodes, and nobody counts past a dozen.
 */
export const MAX_CARRIAGES = 24;

/**
 * Carriages for a gap this wide, or null when not even the locomotive fits —
 * which is the case a dashed line is still for.
 */
export function carriagesFor(gapPx: number): number | null {
  const usable = gapPx - 2 * TRAIN_PAD_PX;
  if (!Number.isFinite(usable) || usable < LOCO_PX) return null;
  const room = usable - LOCO_PX;
  return Math.min(MAX_CARRIAGES, Math.floor(room / (CARRIAGE_PX + COUPLING_PX)));
}

/** What the drawn train actually measures, so it can be centred in the gap. */
export function trainWidth(carriages: number): number {
  return LOCO_PX + carriages * (CARRIAGE_PX + COUPLING_PX);
}

/**
 * Where the train stands when the gap runs off the edge of the chart.
 *
 * The middle of the gap is where it belongs, and that is where it stays for as
 * long as the whole gap is on screen. Zoom in past the point where the middle
 * scrolls out of the window, though, and a train centred on it is a train
 * nobody can see — which is exactly what the chart used to do: cross a country
 * by train, zoom into either end of that crossing, and the train vanished
 * along with every clue as to why the line was dashed there.
 *
 * So the train slides along its own gap far enough to come back into view, and
 * no further. It never leaves the stretch it stands for, and it never moves at
 * all while the gap's middle is comfortably visible.
 *
 * `null` means the gap is off screen entirely and there is nothing to place.
 * A window too narrow to hold the whole train gets it centred on what can be
 * seen, with the ends running past the edges — better half a locomotive than
 * none.
 */
export function trainCentre(
  from: number,
  to: number,
  viewFrom: number,
  viewTo: number,
  width: number,
): number | null {
  const visibleFrom = Math.max(from, viewFrom);
  const visibleTo = Math.min(to, viewTo);
  if (!(visibleTo > visibleFrom)) return null;

  const half = width / 2;
  const lo = visibleFrom + half;
  const hi = visibleTo - half;
  if (hi < lo) return (visibleFrom + visibleTo) / 2;
  return Math.min(hi, Math.max(lo, (from + to) / 2));
}

/**
 * How much of a gap is on screen — the room a train actually has, which is the
 * whole gap only while the whole gap is visible.
 */
export function visibleGap(from: number, to: number, viewFrom: number, viewTo: number): number {
  return Math.max(0, Math.min(to, viewTo) - Math.max(from, viewFrom));
}

/** Air between the train and the dashes either side of it. */
export const DASH_CLEARANCE_PX = 5;

export interface Fitted {
  /** Carriages to draw, or null when nothing fits and the gap is only dashed. */
  carriages: number | null;
  /** Where the vehicle hangs, in chart units; null when there is nowhere. */
  centre: number | null;
  /** What it stands on, clearance included, in chart units. */
  occupied: number;
}

/**
 * Everything about a hop that depends on the zoom, in one place.
 *
 * This lives here rather than in the chart because it is where the bug was, and
 * because it is the one calculation in the chart that mixes two coordinate
 * systems: the gap arrives in the SVG's own stretched units, every size a
 * vehicle has is in CSS pixels, and the answer has to go back into stretched
 * units to be positioned. `unitsPerPx` is the exchange rate, and getting it the
 * wrong way up draws a train that looks right on a 960 px screen and nowhere
 * else — hence a pure function with the arithmetic pinned by tests.
 *
 * `pulls` is what separates a train, which is as long as its gap has room for,
 * from a ferry or a bus, which is one shape that either fits or does not.
 */
export function fitVehicle(
  fromX: number,
  toX: number,
  viewFrom: number,
  viewTo: number,
  unitsPerPx: number,
  pulls: boolean,
): Fitted {
  const nothing: Fitted = { carriages: null, centre: null, occupied: 0 };
  // No measurement yet — on the server, and on the first paint before the
  // resize observer has reported. Dashes only; a guessed width draws a train
  // too long for its gap on every chart narrower than the viewBox.
  if (!(unitsPerPx > 0)) return nothing;

  // The room is the part of the gap that is on screen, not the whole gap:
  // zoomed into one end of a long crossing, the rest of that gap is off the
  // side of the chart and cannot hold anything.
  const gapPx = visibleGap(fromX, toX, viewFrom, viewTo) / unitsPerPx;
  const carriages = pulls ? carriagesFor(gapPx) : gapPx - 2 * TRAIN_PAD_PX >= VEHICLE_PX ? 0 : null;
  if (carriages === null) return nothing;

  const widthPx = pulls ? trainWidth(carriages) : VEHICLE_PX;
  const occupied = (widthPx + 2 * DASH_CLEARANCE_PX) * unitsPerPx;
  const centre = trainCentre(fromX, toX, viewFrom, viewTo, occupied);
  return centre === null ? nothing : { carriages, centre, occupied };
}

/**
 * The stretches of a gap the train does not stand on, as `[from, to]` pairs.
 *
 * A train never fills its gap exactly — there is whatever was left over after
 * the last whole carriage, at both ends. Left blank that reads as the line
 * simply stopping; dashed, it reads as the journey carrying on past what the
 * train had room to say.
 *
 * `occupied` is what the train takes up, clearance included, in the same units
 * as `from` and `to`; zero for a gap with no train in it at all. `centre` is
 * where it stands, which is the middle of the gap until `trainCentre` slides
 * it to stay on screen — the dashes have to follow it, or a train shunted
 * towards one end would stand on top of the dashes at that end and leave a
 * bare stretch at the other. Runs shorter than `minRun` are dropped — two
 * dashes wedged against a locomotive are dirt, not information.
 */
export function dashRuns(
  from: number,
  to: number,
  occupied: number,
  centre = (from + to) / 2,
  minRun = 3,
): [number, number][] {
  if (occupied <= 0) return to - from >= minRun ? [[from, to]] : [];
  const middle = centre;
  const half = occupied / 2;
  return ([
    [from, middle - half],
    [middle + half, to],
  ] as [number, number][]).filter(([a, b]) => b - a >= minRun);
}
