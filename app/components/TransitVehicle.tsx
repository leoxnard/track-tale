import { CARRIAGE_PX, COUPLING_PX, LOCO_PX } from "../lib/train-fit";
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
 * Everything is drawn in a viewBox that matches its pixel size one to one, so
 * nothing is ever scaled and the strokes stay honest.
 */

const H = 16;
/** Where the rails would be; every vehicle rests its wheels on this line. */
const RAIL_Y = 12.2;
/** Small, and in pairs: a bogie is what makes a box read as rolling stock
 *  rather than as a bus. */
const WHEEL_R = 1.8;
const PAPER = "#fbfaf7";

function Wheels({ xs, color, r = WHEEL_R }: { xs: number[]; color: string; r?: number }) {
  return (
    <>
      {xs.map((x) => (
        <circle key={x} cx={x} cy={RAIL_Y} r={r} fill={color} stroke={PAPER} strokeWidth={0.7} />
      ))}
    </>
  );
}

function Locomotive({ color }: { color: string }) {
  return (
    <svg width={LOCO_PX} height={H} viewBox={`0 0 ${LOCO_PX} ${H}`} aria-hidden="true">
      {/* Body, with the cab at the leading end — the train faces the way the
          journey goes, which on this axis is to the right. */}
      <path
        d={`M1.6 11.4 L1.6 5.8 Q1.6 5 2.4 5 L15.4 5 L15.4 2.4 Q15.4 1.6 16.2 1.6 L21.6 1.6
            Q22.4 1.6 22.7 2.3 L23.7 5.6 Q24 6.4 24 7.2 L24 11.4 Z`}
        fill={color}
      />
      {/* Cab window, and a louvre band along the hood. */}
      <rect x={16.6} y={2.9} width={5} height={3.4} rx={0.7} fill={PAPER} />
      <rect x={3.4} y={6.6} width={10.6} height={2.2} rx={0.6} fill={PAPER} opacity={0.8} />
      {/* The roof vent: half of what tells a locomotive from a carriage at
          this size, the other half being that it is solid. */}
      <rect x={7} y={3.4} width={5} height={1.6} rx={0.6} fill={color} />
      <Wheels xs={[4.4, 7.4, 16.6, 19.6]} color={color} />
    </svg>
  );
}

function Carriage({ color }: { color: string }) {
  return (
    <svg width={CARRIAGE_PX} height={H} viewBox={`0 0 ${CARRIAGE_PX} ${H}`} aria-hidden="true">
      <rect x={0.4} y={3.8} width={16.2} height={7.6} rx={1.1} fill={color} />
      {[2.2, 5.8, 9.4, 13].map((x) => (
        <rect key={x} x={x} y={5.4} width={2.8} height={2.8} rx={0.5} fill={PAPER} opacity={0.85} />
      ))}
      <Wheels xs={[2.9, 5.7, 11.3, 14.1]} color={color} />
    </svg>
  );
}

function Ferry({ color }: { color: string }) {
  return (
    <svg width={LOCO_PX} height={H} viewBox={`0 0 ${LOCO_PX} ${H}`} aria-hidden="true">
      {/* Hull, cut away at the bow so it reads as a boat rather than a box. */}
      <path d={`M2 7.5 L23.5 7.5 L20 13 Q19.4 13.6 18.6 13.6 L5 13.6 Q2 11 2 7.5 Z`} fill={color} />
      <rect x={6} y={3} width={9} height={4} rx={1} fill={color} />
      <rect x={7.5} y={4.2} width={2.4} height={2} rx={0.5} fill={PAPER} opacity={0.85} />
      <rect x={11} y={4.2} width={2.4} height={2} rx={0.5} fill={PAPER} opacity={0.85} />
      <rect x={17} y={1.6} width={1.4} height={5.9} rx={0.6} fill={color} />
    </svg>
  );
}

function Bus({ color }: { color: string }) {
  return (
    <svg width={LOCO_PX} height={H} viewBox={`0 0 ${LOCO_PX} ${H}`} aria-hidden="true">
      <path
        d={`M2 11 L2 4.4 Q2 3.4 3 3.4 L20 3.4 Q22.4 3.4 23.2 5.6 L23.9 8.2
            Q24 9 24 9.8 L24 11 Z`}
        fill={color}
      />
      {[3.6, 7.4, 11.2, 15].map((x) => (
        <rect key={x} x={x} y={5} width={3} height={2.8} rx={0.6} fill={PAPER} opacity={0.85} />
      ))}
      <rect x={19.4} y={5} width={3} height={2.8} rx={0.6} fill={PAPER} opacity={0.6} />
      {/* A bus rides on two big wheels, not on bogies. */}
      <Wheels xs={[6.5, 18]} color={color} r={2.3} />
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
  const body =
    mode === "ferry" ? <Ferry color={color} /> : mode === "bus" ? <Bus color={color} /> : null;

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
      {body ?? (
        <>
          {Array.from({ length: carriages }, (_, i) => (
            <Carriage key={i} color={color} />
          ))}
          <Locomotive color={color} />
        </>
      )}
    </span>
  );
}
