/**
 * The vehicles again, this time onto a canvas.
 *
 * The map can only repeat an *image* along a line, so the train the tour
 * profile draws as SVG has to be painted a second way. Both read the same
 * shapes out of vehicle-art, which is the point of that file: the drawing is
 * described once and rendered by whichever technology is at hand.
 */

import { artBounds, PAPER, RAIL_Y, vehicleArt, type Shape } from "./vehicle-art";
import type { TransitMode } from "./transport";

/**
 * How big the badge is on the map, in CSS pixels.
 *
 * Settled by looking at it on a line at real size. Much under this and the
 * locomotive inside is a smudge — an emoji is drawn to survive being tiny and
 * a line drawing is not — while much over it and the badge stops being a note
 * on the route and starts being the point of the map.
 */
export const BADGE_PX = 36;
/** Ring thickness, and the air between it and the vehicle inside. */
const RING_PX = 2;
const BADGE_PAD = 2;

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
 * The badge the map repeats along a travelled line: the vehicle on a disc of
 * the page's own paper, ringed in the day's colour.
 *
 * Only the vehicle — no carriages. A train of them would have to be as long
 * as the leg to mean anything, and the leg changes length at every zoom;
 * the line underneath is already hatched like a railway, so the badge only
 * has to name what ran on it.
 *
 * Drawn into the top left of a context already scaled for the device.
 */
export function drawVehicleBadge(
  ctx: CanvasRenderingContext2D,
  { mode, color, size = BADGE_PX }: { mode: TransitMode; color: string; size?: number },
) {
  const radius = size / 2;
  ctx.beginPath();
  ctx.arc(radius, radius, radius - RING_PX / 2, 0, Math.PI * 2);
  ctx.fillStyle = PAPER;
  ctx.fill();
  ctx.lineWidth = RING_PX;
  ctx.strokeStyle = color;
  ctx.stroke();

  // Fitted to what the drawing actually occupies rather than to its box, and
  // centred on the same — otherwise the locomotive sits low and left of the
  // middle by however much empty space its box happens to carry.
  const art = vehicleArt(mode);
  const { top, bottom } = artBounds(art.shapes);
  const inner = size - 2 * (RING_PX + BADGE_PAD);
  const scale = Math.min(inner / art.width, inner / (bottom - top));

  ctx.save();
  ctx.translate(radius - (art.width * scale) / 2, radius - ((top + bottom) / 2) * scale);
  ctx.scale(scale, scale);
  paintShapes(ctx, art.shapes, color, 0);
  ctx.restore();
}
