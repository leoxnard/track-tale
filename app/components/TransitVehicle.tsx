import {
  CARRIAGE_ART,
  PAPER,
  RAIL_Y,
  VEHICLE_H,
  vehicleArt,
  type Paint,
  type Shape,
} from "../lib/vehicle-art";
import type { TransitMode } from "../lib/transport";

/**
 * The little vehicles that sit in the hole an interruption left in a day.
 *
 * Drawn rather than set in emoji: an emoji is a different picture in every
 * browser, cannot be given the day's colour, and — the reason this exists —
 * cannot be lengthened. A train that crossed a third of the country should
 * look longer than one that hopped two valleys, so the train is a locomotive
 * with as many carriages as the gap has room for.
 *
 * One vehicle per element, placed by the chart rather than flowed in a row:
 * a long train is mostly off screen, and the chart only builds the vehicles
 * the window can see. Laying them out as a row would mean building all of
 * them — including a thousand carriages nobody will ever look at — just to
 * have the browser put the visible few in the right place.
 *
 * The shapes themselves live in lib/vehicle-art, because the map draws the
 * same train onto a canvas.
 */

function Drawing({ width, shapes, color }: { width: number; shapes: Shape[]; color: string }) {
  const fill = (paint: Paint) => (paint === "paper" ? PAPER : color);
  return (
    <svg width={width} height={VEHICLE_H} viewBox={`0 0 ${width} ${VEHICLE_H}`} aria-hidden="true">
      {shapes.map((shape, i) =>
        shape.kind === "rect" ? (
          <rect
            key={i}
            x={shape.x}
            y={shape.y}
            width={shape.w}
            height={shape.h}
            rx={shape.rx}
            fill={fill(shape.paint)}
            opacity={shape.opacity}
          />
        ) : shape.kind === "path" ? (
          <path key={i} d={shape.d} fill={fill(shape.paint)} />
        ) : (
          // Wheels sit *on* the rail rather than centred on it, so a driving
          // wheel and a bogie can differ in size and still run on one line.
          <circle
            key={i}
            cx={shape.x}
            cy={RAIL_Y - shape.r}
            r={shape.r}
            fill={color}
            stroke={PAPER}
            strokeWidth={0.7}
          />
        ),
      )}
    </svg>
  );
}

/**
 * One vehicle of a transit hop: the engine at the front, or a carriage behind
 * it. `mode` only decides what the engine looks like — every carriage is the
 * same carriage, and a ferry has none.
 */
export function TransitVehicle({
  mode,
  kind,
  color,
}: {
  mode: TransitMode;
  kind: "engine" | "carriage";
  color: string;
}) {
  return <Drawing {...(kind === "engine" ? vehicleArt(mode) : CARRIAGE_ART)} color={color} />;
}
