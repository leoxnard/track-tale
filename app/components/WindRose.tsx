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
 * The wind of a day — or of a whole trip — as a wind rose drawn around the rider.
 *
 * The figure is the standard meteorological one: sixteen sectors, each petal
 * reaching out from the centre by how much riding happened with the wind out of
 * that direction, banded into speed classes from the hub outwards, a key naming
 * the classes and the outer ring labelled with its value. Two things are changed
 * from the convention, both on purpose.
 *
 * The radial measure counts **kilometres ridden** where a weather station counts
 * hours — the same idea in the units the trip is in.
 *
 * And the rose is turned into the **rider's frame**: up is the direction of
 * travel, not north, so a petal's angle is where the wind sat relative to the
 * nose. This one is not decoration, it is the whole point. Drawn compass-first —
 * as this was at first — a lap of a lake is unreadable: the mean heading of a
 * loop is nothing at all, so the marker in the middle points somewhere arbitrary
 * and "petals in front of the nose" stops meaning anything, on exactly the rides
 * where the wind was most obviously half a gift and half a tax. In the
 * rider's frame that lap draws itself honestly: petals ahead for the quarter
 * ridden into it, petals behind for the quarter that pushed. It also makes two
 * days comparable at a glance, which the compass version only appeared to do.
 *
 * So the arrow sits still and the wind moves around it. Where the wind came from
 * geographically is a fact about the map, not about the riding, and it is one
 * line of text under the picture.
 */

const CENTER = 80;
/** How far the longest petal reaches; the ahead/right/behind/left labels and the
 *  mean-wind arrow live in the margin outside it, which is why it stops well
 *  short of the 160-unit box. */
const OUTER = 56;
/** The hub the heading arrow sits in; petals start just outside it. */
const HUB = 25;
const PETAL_MAX = OUTER - HUB - 2;

interface Props {
  wind: WindAnalysis;
  /** Rendered width in CSS pixels; the drawing scales to it. */
  size?: number;
  /** The day's colour, used for the heading arrow so it belongs to its day. */
  color?: string;
  /**
   * Whether to print the speed-class key. On once, at the top of the page: the
   * ramp is the same on every rose below, and a legend repeated down twenty days
   * is twenty times the ink for the same sentence.
   */
  showScale?: boolean;
}

/**
 * Point on the ring at a bearing from the rider's nose, which is straight up.
 * SVG y grows downwards, hence the quarter turn.
 *
 * Rounded, and that matters: at full precision the last bits of `Math.cos` do
 * not always agree between the Node that renders the page and the browser that
 * hydrates it, and React then reports every petal as a mismatch and gives up on
 * patching them. Two decimals on a 160-unit box is a ten-thousandth of the
 * drawing — invisible, deterministic, and a good deal less markup.
 */
function pointAt(deg: number, r: number): [number, number] {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [round(CENTER + r * Math.cos(rad)), round(CENTER + r * Math.sin(rad))];
}

/**
 * Where a cumulative distance within a petal lands on the radial axis. The axis
 * runs from the hub to the busiest sector's total, shared by every petal, which
 * is what makes their lengths comparable.
 */
function radiusOf(
  metres: number,
  sectorM: number,
  share: number,
  hub: number,
  reach: number,
): number {
  return hub + 2 + (metres / (sectorM || 1)) * share * reach;
}

/**
 * The petals themselves, which are all the little glyph keeps and the middle of
 * what the full figure draws. Taking radii as arguments is what lets one shape
 * serve both: the glyph fills its box, the figure leaves room for its labels.
 */
function Petals({
  wind,
  hub,
  reach,
  titleOf,
}: {
  wind: WindAnalysis;
  hub: number;
  reach: number;
  /** A tooltip per petal — left off the glyph, which is a picture, not a table. */
  titleOf?: (sector: WindAnalysis["sectors"][number]) => string;
}) {
  return (
    <>
      {wind.sectors.map((sector) => {
        if (sector.distanceM === 0) return null;
        // Each class stacks on the one below it, so the petal's total length is
        // still the distance and the bands within it are the speeds.
        let stacked = 0;
        return (
          <g key={sector.relativeDeg}>
            {titleOf && <title>{titleOf(sector)}</title>}
            {sector.bins.map((metres, bin) => {
              if (metres === 0) return null;
              const from = stacked;
              stacked += metres;
              const r0 = radiusOf(from, sector.distanceM, sector.share, hub, reach);
              const r1 = radiusOf(stacked, sector.distanceM, sector.share, hub, reach);
              return (
                <path
                  key={bin}
                  d={petalPath(
                    sector.relativeDeg,
                    r0,
                    // A hairline of paper between the bands, so where one speed
                    // class ends is a boundary and not a hue judgement. Never
                    // thinner than a sliver: a single kilometre out of the
                    // north-east should be visible, not rounded away.
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
    </>
  );
}

/** Two decimals, everywhere a number reaches the markup. See `pointAt`. */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** An annular wedge: the petal for one sector, from `r0` out to `r1`. */
function petalPath(midDeg: number, r0: number, r1: number, widthDeg: number): string {
  const a0 = midDeg - widthDeg / 2;
  const a1 = midDeg + widthDeg / 2;
  const [x0, y0] = pointAt(a0, r0);
  const [x1, y1] = pointAt(a1, r0);
  const [x2, y2] = pointAt(a1, r1);
  const [x3, y3] = pointAt(a0, r1);
  // The radii reach the markup too, so they are rounded with everything else.
  const [c0, c1] = [round(r0), round(r1)];
  return [
    `M ${x0} ${y0}`,
    `A ${c0} ${c0} 0 0 1 ${x1} ${y1}`,
    `L ${x2} ${y2}`,
    `A ${c1} ${c1} 0 0 0 ${x3} ${y3}`,
    "Z",
  ].join(" ");
}

/**
 * The direction of travel, as an arrow up the page — the fixed thing every angle
 * on the rose is measured from.
 *
 * There was a bicycle here, and it had to go. A bicycle is only recognisable
 * from the side, a side view cannot point up the page without standing on its
 * rear wheel, and a plan view of one reads as a dagger. Whichever way it was
 * drawn it said something about direction that it did not mean, in the middle of
 * a figure whose entire subject is direction. An arrow has one meaning and
 * cannot be misread by ninety degrees.
 */
function Heading({ color }: { color: string }) {
  return (
    <g fill={color}>
      <rect x={-1.6} y={-4} width={3.2} height={17} rx={1.6} />
      <path d="M 0 -15.5 L 7.5 -3.5 L 0 -6.5 L -7.5 -3.5 Z" />
    </g>
  );
}

export function WindRose({ wind, size = 124, color = "#1e3a2f", showScale = false }: Props) {
  const m = useMessages();
  const titleId = useId();

  const compass = (deg: number) => m.wind.points[Math.round(norm360(deg) / 22.5) % 16];
  /** A petal's angle in words: "from the right", "ahead on the left". */
  const relative = (deg: number) => m.wind.relative[Math.round(norm360(deg) / 45) % 8];
  const km = (metres: number) => (metres / 1000).toFixed(metres < 10000 ? 1 : 0);

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
            // On the ahead-right diagonal, away from the four labels. A petal
            // can still reach them, which is what the paper-coloured halo
            // underneath the digits is for.
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
                strokeWidth={3}
                paintOrder="stroke"
              >
                {/* The outer ring carries the unit for both. */}
                {fraction === 1 ? `${km(busiestM)} km` : km(busiestM * fraction)}
              </text>
            );
          })}
        </g>

        <Petals
          wind={wind}
          hub={HUB}
          reach={PETAL_MAX}
          titleOf={(sector) =>
            m.wind.petal(
              km(sector.distanceM),
              relative(sector.relativeDeg),
              Math.round(sector.meanKmh),
            )
          }
        />

        {/* Where the wind sat on balance: an arrow outside the ring, blowing
            inwards, because that is the direction the rider felt it come from.
            Left off a ride that met the wind from all sides, where the mean
            angle is an average of opposites and points nowhere real. */}
        {wind.relativeConcentration > 0.2 && (
          <g
            transform={`rotate(${round(wind.relativeDeg)} ${CENTER} ${CENTER})`}
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
        )}

        {/* Four labels, not sixteen: ahead, right, behind, left. They say what
            the angles mean here, which no reader can be assumed to guess from a
            figure that usually has north at the top. */}
        {m.wind.around.map((label, i) => {
          const [x, y] = pointAt(i * 90, OUTER + 6);
          return (
            <text
              key={label}
              x={x}
              y={y}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={9}
              fill="#6b7a72"
            >
              {label}
            </text>
          );
        })}

        {/* Up the page, always: the rose turns with the rider, so this never
            has to. It is the fixed point the angles are measured from. */}
        <g transform={`translate(${CENTER} ${CENTER})`}>
          <Heading color={color} />
        </g>
      </svg>

      <figcaption className="min-w-[13rem] max-w-md flex-1 text-sm">
        {/* One line, because it is one sentence: what the wind did, how hard it
            blew and where from. It read as three before, and three lines of
            small print under every day is a page about the wind. */}
        <p>
          <strong className="font-semibold text-pine">{m.wind.verdicts[verdict]}</strong>
          <span className="text-faint">
            {" · "}
            {m.wind.average(Math.round(wind.windKmh), compass(wind.windFromDeg))}
            {wind.gustKmh > wind.windKmh + 8 && ` · ${m.wind.gusts(Math.round(wind.gustKmh))}`}
            {head !== 0 && ` · ${m.wind.net(Math.abs(head), head > 0)}`}
          </span>
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

        {/* The key to the petals' bands — printed once for the page. */}
        {showScale && (
          <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-faint">
            {m.wind.scale}
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

/**
 * A day's wind in the weather line: an arrow and a speed, and nothing else.
 *
 * The full figure — rose, bar, numbers, key — is worth its room once, at the top
 * of the page. Repeated under every day of a three-week trip it pushed the
 * photographs and the writing off the screen, which is the wrong way round: the
 * wind is context for a day, not the day. Reduced to this it costs a day nothing
 * at all, because it joins a line that was already there beside the temperature
 * and the rain.
 *
 * The arrow is in the **rider's frame**, exactly like the one on the rose it
 * opens: up is the direction of travel, so an arrow pointing down at you is the
 * wind in your face and one pointing up is the wind at your back. A compass
 * arrow was the first version and it was the wrong question — "north-west" tells
 * a reader nothing about a day unless they also remember which way the road ran,
 * which is the whole reason the rose stopped using the compass. Both directions
 * are in the tooltip anyway, in words.
 *
 * On a ride that met the wind from every side there is no mean angle to draw,
 * and the arrow gives way to a ring: the same restraint the rose shows, for the
 * same reason. Pointing somewhere confident would be inventing an answer.
 */
export function WindChip({
  wind,
  open,
  onToggle,
}: {
  wind: WindAnalysis;
  open: boolean;
  onToggle: () => void;
}) {
  const m = useMessages();
  const from = m.wind.points[Math.round(norm360(wind.windFromDeg) / 22.5) % 16];
  const angle = m.wind.relative[Math.round(norm360(wind.relativeDeg) / 45) % 8];
  const settled = wind.relativeConcentration > 0.2;
  const colour = windColor(wind.windKmh);
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      title={
        settled
          ? m.wind.chip(Math.round(wind.windKmh), angle, from)
          : m.wind.chipScattered(Math.round(wind.windKmh), from)
      }
      className="ml-1 inline-flex items-center gap-1 rounded-full px-1 align-baseline hover:text-pine focus-visible:outline-2 focus-visible:outline-pine"
    >
      <svg
        width={12}
        height={12}
        viewBox="0 0 24 24"
        aria-hidden
        // The rose puts its mean-wind arrow at `relativeDeg` pointing inward, so
        // the air travels along `relativeDeg + 180`: at a headwind, down at the
        // rider. Rounded like everything else that reaches the markup — at full
        // precision the server and the browser disagree in the last bits and
        // React calls it a hydration mismatch.
        style={
          settled
            ? { transform: `rotate(${round(norm360(wind.relativeDeg + 180))}deg)` }
            : undefined
        }
        className="shrink-0"
      >
        {settled ? (
          <>
            <path d="M12 2 L18 13 L12 10.5 L6 13 Z" fill={colour} />
            <path d="M12 10 V22" stroke={colour} strokeWidth={2.6} strokeLinecap="round" />
          </>
        ) : (
          <circle cx={12} cy={12} r={7} fill="none" stroke={colour} strokeWidth={3} />
        )}
      </svg>
      {Math.round(wind.windKmh)} km/h
      <span className="sr-only">{m.wind.expand}</span>
    </button>
  );
}
