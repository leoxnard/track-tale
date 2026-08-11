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
 * The stretches of a gap the train does not stand on, as `[from, to]` pairs.
 *
 * A train never fills its gap exactly — there is whatever was left over after
 * the last whole carriage, at both ends. Left blank that reads as the line
 * simply stopping; dashed, it reads as the journey carrying on past what the
 * train had room to say.
 *
 * `occupied` is what the train takes up in the middle, clearance included, in
 * the same units as `from` and `to`; zero for a gap with no train in it at
 * all. Runs shorter than `minRun` are dropped — two dashes wedged against a
 * locomotive are dirt, not information.
 */
export function dashRuns(
  from: number,
  to: number,
  occupied: number,
  minRun = 3,
): [number, number][] {
  if (occupied <= 0) return to - from >= minRun ? [[from, to]] : [];
  const middle = (from + to) / 2;
  const half = occupied / 2;
  return ([
    [from, middle - half],
    [middle + half, to],
  ] as [number, number][]).filter(([a, b]) => b - a >= minRun);
}
