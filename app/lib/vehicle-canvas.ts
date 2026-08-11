/**
 * The vehicles again, this time onto a canvas.
 *
 * The map can only repeat an *image* along a line, so the train the tour
 * profile draws as SVG has to be painted a second way. Both read the same
 * shapes out of vehicle-art, which is the point of that file: the drawing is
 * described once and rendered by whichever technology is at hand.
 */

import { CARRIAGE_PX, COUPLING_PX, LOCO_PX, VEHICLE_PX } from "./train-fit";
import { CARRIAGE_ART, PAPER, RAIL_Y, VEHICLE_H, vehicleArt, type Shape } from "./vehicle-art";
import type { TransitMode } from "./transport";

/** Paper around the train, so it sits in a hole rather than on the line. */
export const PLATE_PAD = 5;

export function trainIconSize(
  mode: TransitMode,
  carriages: number,
): { width: number; height: number } {
  const engineWidth = mode === "train" ? LOCO_PX : VEHICLE_PX;
  const pulled = mode === "train" ? carriages : 0;
  return {
    width: engineWidth + pulled * (CARRIAGE_PX + COUPLING_PX) + 2 * PLATE_PAD,
    height: VEHICLE_H + 2 * PLATE_PAD,
  };
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  // roundRect is recent enough to be worth a fallback: a square-cornered
  // carriage is still a carriage, a missing one is not.
  if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

function paintShapes(
  ctx: CanvasRenderingContext2D,
  shapes: Shape[],
  color: string,
  offsetX: number,
) {
  for (const shape of shapes) {
    ctx.fillStyle = shape.kind !== "wheel" && shape.paint === "paper" ? PAPER : color;
    if (shape.kind === "rect") {
      ctx.globalAlpha = shape.opacity ?? 1;
      roundedRect(ctx, offsetX + shape.x, shape.y, shape.w, shape.h, shape.rx);
      ctx.fill();
      ctx.globalAlpha = 1;
    } else if (shape.kind === "path") {
      ctx.save();
      ctx.translate(offsetX, 0);
      ctx.fill(new Path2D(shape.d));
      ctx.restore();
    } else {
      // Wheels sit *on* the rail rather than centred on it, so a driving wheel
      // and a bogie can differ in size and still run on one line.
      ctx.beginPath();
      ctx.arc(offsetX + shape.x, RAIL_Y - shape.r, shape.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 0.7;
      ctx.strokeStyle = PAPER;
      ctx.stroke();
    }
  }
}

/**
 * Paint the whole train — plate, carriages, engine — into the top left of a
 * context already scaled for the device.
 */
export function drawTrain(
  ctx: CanvasRenderingContext2D,
  { mode, color, carriages }: { mode: TransitMode; color: string; carriages: number },
) {
  const engine = vehicleArt(mode);
  const pulled = mode === "train" ? carriages : 0;
  const { width, height } = trainIconSize(mode, carriages);

  ctx.fillStyle = PAPER;
  roundedRect(ctx, 0, 0, width, height, 4);
  ctx.fill();

  ctx.save();
  ctx.translate(PLATE_PAD, PLATE_PAD);
  let offsetX = 0;
  for (let i = 0; i < pulled; i++) {
    paintShapes(ctx, CARRIAGE_ART.shapes, color, offsetX);
    offsetX += CARRIAGE_PX + COUPLING_PX;
  }
  paintShapes(ctx, engine.shapes, color, offsetX);
  ctx.restore();
}
