import { COUPLING_PX } from "../lib/train-fit";
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
 * @param carriages only meaningful for a train; a ferry pulls nothing.
 */
export function TransitVehicle({
  mode,
  color,
  carriages = 0,
  title,
}: {
  mode: TransitMode;
  color: string;
  carriages?: number;
  title?: string;
}) {
  const engine = vehicleArt(mode);
  const pulls = mode === "train" ? carriages : 0;

  return (
    <span
      // Deliberately not clickable: the chart underneath is scrubbed by moving
      // a pointer across it, and a train that swallowed those events would put
      // a dead patch in the middle of the tour.
      className="flex items-center"
      style={{ gap: `${COUPLING_PX}px` }}
      role="img"
      aria-label={title}
    >
      {Array.from({ length: pulls }, (_, i) => (
        <Drawing key={i} {...CARRIAGE_ART} color={color} />
      ))}
      <Drawing {...engine} color={color} />
    </span>
  );
}
