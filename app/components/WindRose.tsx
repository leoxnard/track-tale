import { useId } from "react";
import { useMessages } from "../lib/locale";
import {
  SECTOR_DEG,
  norm360,
  verdictOf,
  windColor,
  type WindAnalysis,
} from "../lib/wind";

/**
 * The wind of a day — or of a whole trip — as one ring with a bicycle in it.
 *
 * Each petal is a compass sector the wind blew *from*: how far it reaches is
 * how many kilometres were ridden under that wind, and its colour is how hard
 * that wind blew (Beaufort, so the steps are ones a person outdoors notices).
 * The bicycle in the hub points the average direction of travel.
 *
 * That last part is what makes the picture worth drawing rather than tabulating.
 * Petals piling up in front of the bike's nose *are* a day of headwind; the same
 * petals behind the saddle are a day of being pushed along. Nobody has to read a
 * number to see which day they had — the number is underneath for when they do.
 *
 * The rose is in compass space, not the rider's: north is up, always. Turning it
 * into the rider's frame was the first attempt and it read beautifully for one
 * day and became meaningless the moment two days sat above each other, because
 * every rose was then in its own private coordinate system.
 */

const CENTER = 80;
/** How far the longest petal reaches; the compass letters and the mean-wind
 *  arrow live in the margin outside it, which is why it stops well short of the
 *  160-unit box. */
const OUTER = 56;
/** The hub the bicycle sits in; petals start just outside it. */
const HUB = 25;
const PETAL_MAX = OUTER - HUB - 2;

interface Props {
  wind: WindAnalysis;
  /** Rendered width in CSS pixels; the drawing scales to it. */
  size?: number;
  /** The day's colour, used for the bicycle so it belongs to the day it is in. */
  color?: string;
}

/** Point on the ring at a compass bearing — SVG y grows downwards, north is up. */
function pointAt(deg: number, r: number): [number, number] {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [CENTER + r * Math.cos(rad), CENTER + r * Math.sin(rad)];
}

/** An annular wedge: the petal for one sector, from `r0` out to `r1`. */
function petalPath(midDeg: number, r0: number, r1: number, widthDeg: number): string {
  const a0 = midDeg - widthDeg / 2;
  const a1 = midDeg + widthDeg / 2;
  const [x0, y0] = pointAt(a0, r0);
  const [x1, y1] = pointAt(a1, r0);
  const [x2, y2] = pointAt(a1, r1);
  const [x3, y3] = pointAt(a0, r1);
  return [
    `M ${x0} ${y0}`,
    `A ${r0} ${r0} 0 0 1 ${x1} ${y1}`,
    `L ${x2} ${y2}`,
    `A ${r1} ${r1} 0 0 0 ${x3} ${y3}`,
    "Z",
  ].join(" ");
}

/**
 * The bicycle, side on, facing right, drawn about the origin so the transform
 * that aims it is a plain rotate. Strokes rather than a filled silhouette: at
 * this size a filled bike is a blob, and the frame's triangle is the part that
 * says "bicycle" at a glance.
 */
function Bicycle({ color }: { color: string }) {
  return (
    <g
      fill="none"
      stroke={color}
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx={-10} cy={4} r={6} />
      <circle cx={10} cy={4} r={6} />
      {/* Frame: chainstay, seat tube, top tube, down tube, then fork. */}
      <path d="M -10 4 L 0 4 L -4 -5 L 6 -5 L 0 4 M 6 -5 L 9 -1 L 10 4" />
      {/* Saddle and bars, the two bits that make it read as ridden. */}
      <path d="M -6.5 -6 L -1.5 -6" />
      <path d="M 4 -7.5 L 9 -7.5" />
      <path d="M 6.5 -7.5 L 6 -5" />
    </g>
  );
}

export function WindRose({ wind, size = 148, color = "#1e3a2f" }: Props) {
  const m = useMessages();
  const titleId = useId();

  const compass = (deg: number) =>
    m.wind.points[Math.round(norm360(deg) / 22.5) % 16];
  const km = (metres: number) => (metres / 1000).toFixed(metres < 10000 ? 1 : 0);

  // A bicycle rotated past the vertical would ride on its head. Flipping it
  // about its own long axis keeps the wheels down while the nose still points
  // where the riding went — the trick a map label uses to stay upright.
  const spin = wind.travelDeg - 90;
  const upsideDown = norm360(spin) > 90 && norm360(spin) < 270;

  const verdict = verdictOf(wind);
  const head = Math.round(wind.headwindKmh);
  const split = wind.headM + wind.crossM + wind.tailM;
  const bar = [
    { key: "against", metres: wind.headM, fill: "#c2452f" },
    { key: "across", metres: wind.crossM, fill: "#c9b98a" },
    { key: "with", metres: wind.tailM, fill: "#4f9d69" },
  ] as const;

  return (
    <figure className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-3 rounded-xl border border-trail bg-paper/60 p-3">
      <svg
        width={size}
        height={size}
        viewBox="0 0 160 160"
        role="img"
        aria-labelledby={titleId}
        className="shrink-0"
      >
        <title id={titleId}>
          {m.wind.aria(
            m.wind.verdicts[verdict],
            Math.round(wind.windKmh),
            compass(wind.windFromDeg),
            compass(wind.travelDeg),
          )}
        </title>

        {/* The rings the petals are read against: the hub, and the reach of the
            longest petal, so a stubby rose is visibly stubby. */}
        <circle cx={CENTER} cy={CENTER} r={HUB} fill="none" stroke="#e3e0d8" strokeWidth={1} />
        <circle
          cx={CENTER}
          cy={CENTER}
          r={HUB + 3 + PETAL_MAX}
          fill="none"
          stroke="#e3e0d8"
          strokeWidth={1}
          strokeDasharray="2 4"
        />

        {wind.sectors.map((sector) =>
          sector.distanceM === 0 ? null : (
            <path
              key={sector.fromDeg}
              d={petalPath(
                sector.fromDeg,
                HUB + 2,
                // Every sector that saw any riding at all gets a sliver, so a
                // single kilometre from the north-east is visible rather than
                // rounded into nothing.
                HUB + 3 + sector.share * PETAL_MAX,
                SECTOR_DEG - 3,
              )}
              fill={windColor(sector.meanKmh)}
              stroke="#fbfaf7"
              strokeWidth={0.5}
            >
              <title>
                {m.wind.petal(
                  km(sector.distanceM),
                  compass(sector.fromDeg),
                  Math.round(sector.meanKmh),
                )}
              </title>
            </path>
          ),
        )}

        {/* Where the wind sat on balance: an arrow outside the ring, blowing
            inwards, because that is the direction the rider felt it come from. */}
        <g
          transform={`rotate(${wind.windFromDeg} ${CENTER} ${CENTER})`}
          fill={windColor(wind.windKmh)}
          stroke={windColor(wind.windKmh)}
        >
          <path
            d={`M ${CENTER} ${CENTER - OUTER - 10} L ${CENTER - 5} ${CENTER - OUTER - 17} L ${
              CENTER + 5
            } ${CENTER - OUTER - 17} Z`}
          />
          <path
            d={`M ${CENTER} ${CENTER - OUTER - 17} V ${CENTER - OUTER - 23}`}
            strokeWidth={2.5}
            strokeLinecap="round"
          />
        </g>

        {/* Only the four cardinals are labelled: sixteen would be a dial, and
            the rose is meant to be glanced at, not navigated by. */}
        {[0, 4, 8, 12].map((point) => {
          const [x, y] = pointAt(point * 22.5, OUTER + 6);
          return (
            <text
              key={point}
              x={x}
              y={y}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={9}
              fill="#6b7a72"
            >
              {m.wind.points[point]}
            </text>
          );
        })}

        <g
          transform={`translate(${CENTER} ${CENTER}) rotate(${spin})${
            upsideDown ? " scale(1 -1)" : ""
          }`}
        >
          <Bicycle color={color} />
        </g>
      </svg>

      <figcaption className="min-w-[13rem] max-w-md flex-1 text-sm">
        <p className="font-semibold text-pine">{m.wind.verdicts[verdict]}</p>
        <p className="text-faint">
          {m.wind.average(Math.round(wind.windKmh), compass(wind.windFromDeg))}
          {wind.gustKmh > wind.windKmh + 5 && ` · ${m.wind.gusts(Math.round(wind.gustKmh))}`}
        </p>
        <p className="text-faint">
          {head === 0
            ? m.wind.evens
            : head > 0
              ? m.wind.costHead(head)
              : m.wind.costTail(-head)}
        </p>

        {split > 0 && (
          <>
            <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-trail">
              {bar.map(
                (part) =>
                  part.metres > 0 && (
                    <span
                      key={part.key}
                      style={{
                        width: `${(part.metres / split) * 100}%`,
                        backgroundColor: part.fill,
                      }}
                    />
                  ),
              )}
            </div>
            <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-faint">
              {bar.map(
                (part) =>
                  part.metres > 0 && (
                    <span key={part.key} className="inline-flex items-center gap-1">
                      <span
                        className="inline-block h-2 w-2 rounded-full"
                        style={{ backgroundColor: part.fill }}
                      />
                      {m.wind.legs[part.key](km(part.metres))}
                    </span>
                  ),
              )}
            </p>
          </>
        )}

        {/* Only worth saying when a real slice of the day is missing: a track
            without timestamps, or a stretch the hourly series didn't reach. */}
        {wind.coverage < 0.9 && (
          <p className="mt-1 text-xs text-faint">
            {m.wind.coverage(Math.round(wind.coverage * 100))}
          </p>
        )}
      </figcaption>
    </figure>
  );
}
