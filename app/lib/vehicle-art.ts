/**
 * The shapes the little vehicles are made of, as data rather than as markup.
 *
 * They are drawn twice: as SVG in the tour profile, and onto a canvas for the
 * map, which can only repeat an image along a line. Written as JSX they would
 * have had to be drawn twice by hand as well, and the two would have drifted
 * apart the first time either was adjusted.
 *
 * Coordinates are in CSS pixels within a box `VEHICLE_H` tall, so nothing is
 * ever scaled and both renderers can take them as they are.
 */

import type { TransitMode } from "./transport";
import { CARRIAGE_PX, LOCO_PX, VEHICLE_PX } from "./train-fit";

export const VEHICLE_H = 16;
/** The rail: every wheel of every vehicle touches this line, whatever its size. */
export const RAIL_Y = 14.2;
/** Windows and glass, in the page's own paper. */
export const PAPER = "#fbfaf7";

/** `body` is the day's colour; `paper` is the page behind it. */
export type Paint = "body" | "paper";

export type Shape =
  | { kind: "rect"; x: number; y: number; w: number; h: number; rx: number; paint: Paint; opacity?: number }
  | { kind: "wheel"; x: number; r: number }
  | { kind: "path"; d: string; paint: Paint };

const rect = (
  x: number,
  y: number,
  w: number,
  h: number,
  rx: number,
  paint: Paint = "body",
  opacity?: number,
): Shape => ({ kind: "rect", x, y, w, h, rx, paint, opacity });

/** A wheel is given its size and where it stands; the rail decides the rest. */
const wheel = (x: number, r: number): Shape => ({ kind: "wheel", x, r });

/**
 * The locomotive: facing right, the way the journey goes, with the chimney at
 * the front and the cab at the back where the carriages couple on.
 *
 * It is the steam kind, which is nobody's idea of what runs the
 * Aberdeen–Inverness line and everybody's idea of a locomotive. Drawn modern,
 * at sixteen pixels tall, it is a box with windows — indistinguishable from
 * the carriages behind it and, as the first attempt proved, from a lorry.
 *
 * The silhouette steps *down* towards the front — cab roof, chimney, dome,
 * boiler — which is what makes it an old engine rather than a modern one of
 * even height.
 */
export const LOCOMOTIVE: Shape[] = [
  rect(1.2, 9.6, 29.6, 1.8, 0.6),
  // Boiler, rounded off at the smokebox end: the lowest thing up front.
  rect(12, 4.8, 18.4, 5.2, 2.6),
  // Steam dome, then the chimney with its cap — both under the cab roof.
  rect(18.2, 3.4, 2.8, 1.8, 0.9),
  rect(25.2, 2.7, 2.9, 2.6, 0.5),
  rect(24.2, 2.3, 4.9, 1.3, 0.6),
  // The cab: the tallest part of the engine, roof overhanging both ways.
  rect(3.4, 2.2, 9, 7.8, 1),
  rect(2.2, 1.3, 11.4, 1.5, 0.7),
  rect(5.4, 3.8, 4.6, 3.2, 0.6, "paper"),
  // One big driving wheel under the cab and two carrying wheels under the
  // boiler — the proportion that says "locomotive" before anything else.
  wheel(9.4, 3.3),
  wheel(17.6, 2),
  wheel(23.4, 2),
  // The coupling the first carriage hangs off.
  rect(0, 9.9, 1.6, 1.2, 0.5),
];

/**
 * A carriage: long and low, its roof at the height of the engine's boiler and
 * well under the cab, on bogies set in from its ends. Drawn stubby it read as
 * a crate being pushed along rather than as rolling stock.
 */
export const CARRIAGE: Shape[] = [
  rect(0.4, 4.8, 23.2, 6.6, 1.2),
  ...[2.4, 6.4, 10.4, 14.4, 18.4].map((x) => rect(x, 6.2, 3.2, 2.6, 0.5, "paper", 0.85)),
  wheel(3.6, 1.6),
  wheel(6.4, 1.6),
  wheel(17.4, 1.6),
  wheel(20.2, 1.6),
];

export const FERRY: Shape[] = [
  // Hull, cut away at the bow so it reads as a boat rather than a box.
  { kind: "path", d: "M2 7.8 L23.5 7.8 L20 13.4 Q19.4 14 18.6 14 L5 14 Q2 11.3 2 7.8 Z", paint: "body" },
  rect(6, 3.2, 9, 4.2, 1),
  rect(7.5, 4.4, 2.4, 2, 0.5, "paper", 0.85),
  rect(11, 4.4, 2.4, 2, 0.5, "paper", 0.85),
  rect(17, 1.8, 1.4, 6, 0.6),
];

export const BUS: Shape[] = [
  {
    kind: "path",
    d: "M2 11.6 L2 5 Q2 4 3 4 L20 4 Q22.4 4 23.2 6.2 L23.9 8.8 Q24 9.6 24 10.4 L24 11.6 Z",
    paint: "body",
  },
  ...[3.6, 7.4, 11.2, 15].map((x) => rect(x, 5.6, 3, 2.8, 0.6, "paper", 0.85)),
  rect(19.4, 5.6, 3, 2.8, 0.6, "paper", 0.6),
  // A bus rides on two big wheels, not on bogies.
  wheel(6.5, 2.3),
  wheel(18, 2.3),
];

/**
 * The topmost and bottommost pixel a drawing actually reaches.
 *
 * The box is sixteen tall because that is a convenient number to draw in, not
 * because anything fills it — so anything centring a vehicle has to ask what
 * it really occupies rather than assume the box.
 */
export function artBounds(shapes: Shape[]): { top: number; bottom: number } {
  let top = VEHICLE_H;
  let bottom = 0;
  for (const shape of shapes) {
    if (shape.kind === "rect") {
      top = Math.min(top, shape.y);
      bottom = Math.max(bottom, shape.y + shape.h);
    } else if (shape.kind === "wheel") {
      top = Math.min(top, RAIL_Y - 2 * shape.r);
      bottom = Math.max(bottom, RAIL_Y);
    } else {
      // Every path here is written in absolute coordinate pairs — M, L, Q and
      // Z, nothing that takes a lone number — so the odd numbers are the ys.
      // A hull that ignored this would centre the ferry by its cabin.
      const numbers = (shape.d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
      for (let i = 1; i < numbers.length; i += 2) {
        top = Math.min(top, numbers[i]);
        bottom = Math.max(bottom, numbers[i]);
      }
    }
  }
  return { top, bottom };
}

/** The single vehicle a mode is drawn as, and how wide it is. */
export function vehicleArt(mode: TransitMode): { width: number; shapes: Shape[] } {
  if (mode === "ferry") return { width: VEHICLE_PX, shapes: FERRY };
  if (mode === "bus") return { width: VEHICLE_PX, shapes: BUS };
  return { width: LOCO_PX, shapes: LOCOMOTIVE };
}

export const CARRIAGE_ART = { width: CARRIAGE_PX, shapes: CARRIAGE };
