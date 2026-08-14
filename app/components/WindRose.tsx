import { useId } from "react";
import { useMessages } from "../lib/locale";
import {
  BIN_COLORS,
  SECTOR_DEG,
  binLabel,
  norm360,
  verdictOf,
  windColor,
  type WindAnalysis,
} from "../lib/wind";

/**
 * The wind of a day — or of a whole trip — as a wind rose with a bicycle in it.
 *
 * Deliberately the standard meteorological figure rather than an invention:
 * north up, sixteen sectors, each petal reaching out from the centre by how much
 * happened with the wind out of that direction and banded into speed classes
 * from the hub outwards, with a legend naming the classes and the outer ring
 * labelled with its value. Anyone who has met a wind rose reads this one without
 * being told, and anyone who hasn't can learn it from the legend. The one thing
 * changed from the convention is the radial measure: a weather station counts
 * hours, this counts *kilometres ridden*, which is the same idea told in the
 * units the trip is in.
 *
 * The bicycle in the hub is the part that is ours, and it is what makes the
 * picture worth drawing rather than tabulating: it points the average heading,
 * so petals crowding its nose *are* a day of headwind and petals behind the
 * saddle *are* a day of being pushed along. Nobody has to read a number to see
 * which day they had — the numbers are underneath for when they do.
 *
 * The rose stays in compass space, not the rider's. Turning it into the rider's
 * frame was tried first: it read beautifully for one day and became meaningless
 * the moment two days sat above each other, because every rose was then in its
 * own private coordinate system, and it threw away the convention that makes the
 * figure legible on sight.
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

/**
 * Where a cumulative distance within a petal lands on the radial axis. The axis
 * runs from the hub to the busiest sector's total, shared by every petal, which
 * is what makes their lengths comparable.
 */
function radiusOf(metres: number, sectorM: number, share: number): number {
  return HUB + 2 + (metres / (sectorM || 1)) * share * PETAL_MAX;
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

  const busiestM = Math.max(...wind.sectors.map((s) => s.distanceM));
  const verdict = verdictOf(wind);
  const head = Math.round(wind.headwindKmh);
  const split = wind.headM + wind.crossM + wind.tailM;
  // Deliberately no hue: the rose already spends warm colour on wind *strength*,
  // and this bar answers a different question — the *angle* the wind came at.
  // Red here would be a second meaning for the same red, an arm's length away.
  // Dark to pale reads as hard to easy instead, and each band is labelled.
  const bar = [
    { key: "against", metres: wind.headM, fill: "#1e3a2f" },
    { key: "across", metres: wind.crossM, fill: "#7f9187" },
    { key: "with", metres: wind.tailM, fill: "#cbd6cb" },
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

        {/* The radial axis: the hub, a ring at half the busiest sector and one
            at all of it, each labelled — without them a petal's length is a
            shape, and with them it is a number of kilometres. */}
        <circle cx={CENTER} cy={CENTER} r={HUB} fill="none" stroke="#e3e0d8" strokeWidth={1} />
        {[0.5, 1].map((fraction) => (
          <circle
            key={fraction}
            cx={CENTER}
            cy={CENTER}
            r={HUB + 2 + fraction * PETAL_MAX}
            fill="none"
            stroke="#e3e0d8"
            strokeWidth={1}
            strokeDasharray="2 4"
          />
        ))}
        <g>
          <title>{m.wind.axis}</title>
          {[0.5, 1].map((fraction) => {
            // Along the north-east spoke, where petals are least likely to be:
            // the prevailing wind of a European trip is rarely from there.
            const [x, y] = pointAt(45, HUB + 2 + fraction * PETAL_MAX);
            return (
              <text
                key={fraction}
                x={x}
                y={y}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={7.5}
                fill="#6b7a72"
                stroke="#fbfaf7"
                strokeWidth={2.5}
                paintOrder="stroke"
              >
                {/* The outer ring carries the unit for both. */}
                {fraction === 1 ? `${km(busiestM)} km` : km(busiestM * fraction)}
              </text>
            );
          })}
        </g>

        {wind.sectors.map((sector) => {
          if (sector.distanceM === 0) return null;
          // Each class stacks on the one below it, so the petal's total length
          // is still the distance and the bands within it are the speeds.
          let stacked = 0;
          return (
            <g key={sector.fromDeg}>
              <title>
                {m.wind.petal(
                  km(sector.distanceM),
                  compass(sector.fromDeg),
                  Math.round(sector.meanKmh),
                )}
              </title>
              {sector.bins.map((metres, bin) => {
                if (metres === 0) return null;
                const from = stacked;
                stacked += metres;
                const r0 = radiusOf(from, sector.distanceM, sector.share);
                const r1 = radiusOf(stacked, sector.distanceM, sector.share);
                return (
                  <path
                    key={bin}
                    d={petalPath(
                      sector.fromDeg,
                      r0,
                      // A hairline of paper between the bands, so where one
                      // speed class ends is a boundary and not a hue judgement.
                      // Never thinner than a sliver: a single kilometre out of
                      // the north-east should be visible, not rounded away.
                      Math.max(r0 + 0.7, r1 - 0.9),
                      SECTOR_DEG - 3,
                    )}
                    fill={BIN_COLORS[bin]}
                  />
                );
              })}
            </g>
          );
        })}

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

        {/* The key to the petals' bands. Always present: the ramp is ordered,
            not named, and without this the colours are a mood. */}
        <p className="mt-3 text-xs text-faint">{m.wind.scale}</p>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-faint">
          {BIN_COLORS.map((fill, bin) => (
            <span key={bin} className="inline-flex items-center gap-1">
              <span
                className="inline-block h-2.5 w-3.5 rounded-[2px] ring-1 ring-trail"
                style={{ backgroundColor: fill }}
              />
              {binLabel(bin)}
            </span>
          ))}
        </p>

        {/* Only worth saying when a real slice of the day is missing: a track
            without timestamps, or a stretch the hourly series didn't reach. */}
        {wind.coverage < 0.9 && (
          <p className="mt-2 text-xs text-faint">
            {m.wind.coverage(Math.round(wind.coverage * 100))}
          </p>
        )}
      </figcaption>
    </figure>
  );
}
