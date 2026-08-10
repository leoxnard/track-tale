import { CARRIAGE_PX, COUPLING_PX, LOCO_PX, VEHICLE_PX } from "../lib/train-fit";
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
 * The locomotive is the steam kind, which is nobody's idea of what runs the
 * Aberdeen–Inverness line and everybody's idea of a locomotive. Drawn modern,
 * at sixteen pixels tall, it is a box with windows — indistinguishable from
 * the carriages behind it and, as the first attempt proved, from a lorry. A
 * chimney, a boiler and one big driving wheel read at any size, which is the
 * whole job here.
 *
 * Everything is drawn in a viewBox that matches its pixel size one to one, so
 * nothing is ever scaled and the strokes stay honest.
 */

const H = 16;
/** The rail: every wheel of every vehicle touches this line, whatever its size. */
const RAIL_Y = 14.2;
const PAPER = "#fbfaf7";

/** Wheels sit *on* the rail rather than centred on it, so sizes can differ. */
function Wheels({ xs, color, r }: { xs: number[]; color: string; r: number }) {
  return (
    <>
      {xs.map((x) => (
        <circle key={x} cx={x} cy={RAIL_Y - r} r={r} fill={color} stroke={PAPER} strokeWidth={0.7} />
      ))}
    </>
  );
}

function Locomotive({ color }: { color: string }) {
  return (
    <svg width={LOCO_PX} height={H} viewBox={`0 0 ${LOCO_PX} ${H}`} aria-hidden="true">
      {/* Facing right, the way the journey goes: chimney at the front, cab at
          the back where the carriages couple on. */}
      <rect x={1.2} y={9.6} width={29.6} height={1.8} rx={0.6} fill={color} />
      {/* Boiler, rounded off at the smokebox end. */}
      <rect x={12} y={4.4} width={18.4} height={5.6} rx={2.8} fill={color} />
      {/* Steam dome, then the chimney with its cap. */}
      <rect x={18.4} y={2.9} width={2.8} height={2} rx={1} fill={color} />
      <rect x={25.2} y={1.6} width={2.9} height={3.4} rx={0.5} fill={color} />
      <rect x={24.2} y={1.2} width={4.9} height={1.4} rx={0.6} fill={color} />
      {/* The cab: the tall part, roof overhanging both ways. */}
      <rect x={3.4} y={3} width={9} height={7} rx={1} fill={color} />
      <rect x={2.4} y={2.2} width={11} height={1.5} rx={0.7} fill={color} />
      <rect x={5.4} y={4.6} width={4.6} height={3.2} rx={0.6} fill={PAPER} />
      {/* One big driving wheel under the cab and two carrying wheels under the
          boiler — the proportion that says "locomotive" before anything else. */}
      <Wheels xs={[9.4]} color={color} r={3.3} />
      <Wheels xs={[17.6, 23.4]} color={color} r={2} />
      {/* The coupling the first carriage hangs off. */}
      <rect x={0} y={9.9} width={1.6} height={1.2} rx={0.5} fill={color} />
    </svg>
  );
}

function Carriage({ color }: { color: string }) {
  return (
    <svg width={CARRIAGE_PX} height={H} viewBox={`0 0 ${CARRIAGE_PX} ${H}`} aria-hidden="true">
      <rect x={0.4} y={4.4} width={16.2} height={7} rx={1.1} fill={color} />
      {[2.2, 5.8, 9.4, 13].map((x) => (
        <rect key={x} x={x} y={5.8} width={2.8} height={2.6} rx={0.5} fill={PAPER} opacity={0.85} />
      ))}
      <Wheels xs={[3.4, 6.2, 10.8, 13.6]} color={color} r={1.6} />
    </svg>
  );
}

function Ferry({ color }: { color: string }) {
  return (
    <svg width={VEHICLE_PX} height={H} viewBox={`0 0 ${VEHICLE_PX} ${H}`} aria-hidden="true">
      {/* Hull, cut away at the bow so it reads as a boat rather than a box. */}
      <path d={`M2 7.8 L23.5 7.8 L20 13.4 Q19.4 14 18.6 14 L5 14 Q2 11.3 2 7.8 Z`} fill={color} />
      <rect x={6} y={3.2} width={9} height={4.2} rx={1} fill={color} />
      <rect x={7.5} y={4.4} width={2.4} height={2} rx={0.5} fill={PAPER} opacity={0.85} />
      <rect x={11} y={4.4} width={2.4} height={2} rx={0.5} fill={PAPER} opacity={0.85} />
      <rect x={17} y={1.8} width={1.4} height={6} rx={0.6} fill={color} />
    </svg>
  );
}

function Bus({ color }: { color: string }) {
  return (
    <svg width={VEHICLE_PX} height={H} viewBox={`0 0 ${VEHICLE_PX} ${H}`} aria-hidden="true">
      <path
        d={`M2 11.6 L2 5 Q2 4 3 4 L20 4 Q22.4 4 23.2 6.2 L23.9 8.8
            Q24 9.6 24 10.4 L24 11.6 Z`}
        fill={color}
      />
      {[3.6, 7.4, 11.2, 15].map((x) => (
        <rect key={x} x={x} y={5.6} width={3} height={2.8} rx={0.6} fill={PAPER} opacity={0.85} />
      ))}
      <rect x={19.4} y={5.6} width={3} height={2.8} rx={0.6} fill={PAPER} opacity={0.6} />
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
