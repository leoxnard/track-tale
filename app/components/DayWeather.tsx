import { useMessages } from "../lib/locale";
import { hasTemperature, type RidingWeather } from "../lib/riding-weather";
import type { DayWeather } from "../lib/weather";

/**
 * The two panels behind a day's temperature and rain, and the chips that open
 * them.
 *
 * The weather line under a day is three facts wide and each of them has more
 * behind it than fits: a range of temperatures is the shape of a morning, and a
 * millimetre total is the difference between drizzle all day and one savage
 * hour. Both live one tap away, in the same drawer the wind rose uses, so the
 * line stays a line.
 *
 * What the panels do *not* do is put a clock on anything. The hourly stamps are
 * absolute and the trip's timezone is not in the page, so "07:00" would be an
 * hour or two out for exactly the reader it matters to. The charts are shaped
 * left to right by the ride itself and labelled by value, never by time.
 */

const CHART_W = 260;
const CHART_H = 46;
/**
 * Room above and below the plot for the two labels, which hang off the highest
 * and lowest points and would otherwise be sliced off by the viewBox — the line
 * touches the very top and bottom of its own box by construction.
 */
const CHART_TOP = 16;
const CHART_BOTTOM = 18;
/** And at the sides, where the first and last dots sit exactly on the edge. */
const CHART_SIDE = 6;

/** Two decimals, everywhere a number reaches the markup — see `WindRose`. */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function chipClass(open: boolean): string {
  return `inline-flex items-center gap-1 rounded-full px-1 align-baseline focus-visible:outline-2 focus-visible:outline-pine ${
    open ? "text-pine" : "hover:text-pine"
  }`;
}

/**
 * How the temperature ran while they were out in it.
 *
 * A line rather than a bar per hour: temperature is a continuous thing and the
 * question is its shape — did it climb all morning, did it fall off a pass —
 * which bars break into steps and a line does not.
 */
export function TemperaturePanel({ riding }: { riding: RidingWeather }) {
  const m = useMessages();
  const points = riding.hours.filter((h) => h.tempC !== null);
  const values = points.map((h) => h.tempC!);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  // A degree of headroom either side, and never a flat line pinned to the edge:
  // an hour that held steady should read as steady, not as missing.
  const span = Math.max(hi - lo, 2);
  const mid = (hi + lo) / 2;
  const top = mid + span / 2;
  const x = (i: number) => round((i / Math.max(1, points.length - 1)) * CHART_W);
  const y = (v: number) => round(CHART_H - ((v - (top - span)) / span) * CHART_H);

  return (
    <div className="mt-3 rounded-xl border border-trail bg-paper/60 p-3">
      <p className="text-sm">
        <strong className="font-semibold text-pine">
          {Math.round(riding.tempMinC)}–{Math.round(riding.tempMaxC)}°C
        </strong>
        <span className="text-faint">
          {" · "}
          {m.riding.mean(Math.round(riding.tempMeanC))}
        </span>
      </p>
      {points.length > 1 && (
        <svg
          viewBox={`${-CHART_SIDE} ${-CHART_TOP} ${CHART_W + CHART_SIDE * 2} ${
            CHART_H + CHART_TOP + CHART_BOTTOM
          }`}
          // No width or height of its own: with a viewBox and a width from the
          // page, the height follows the aspect ratio. Pinning the height as
          // well made the browser letterbox the drawing inside it.
          className="mt-2 w-full max-w-md"
          role="img"
          aria-label={m.riding.tempAria(
            Math.round(riding.tempMinC),
            Math.round(riding.tempMaxC),
          )}
        >
          <polyline
            points={points.map((h, i) => `${x(i)},${y(h.tempC!)}`).join(" ")}
            fill="none"
            stroke="#2e5243"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {/* The two ends of the range, marked where they happened. */}
          {[
            { v: hi, fill: "#c33320" },
            { v: lo, fill: "#5b8ea6" },
          ].map(({ v, fill }) => {
            const i = values.indexOf(v);
            return (
              <g key={fill}>
                <circle cx={x(i)} cy={y(v)} r={3} fill={fill} />
                <text
                  x={x(i)}
                  y={y(v) + (v === hi ? -7 : 13)}
                  textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}
                  fontSize={10}
                  fill="#6b7a72"
                >
                  {Math.round(v)}°
                </text>
              </g>
            );
          })}
        </svg>
      )}
      <p className="mt-1 text-xs text-faint">{m.riding.overHours(points.length)}</p>
    </div>
  );
}

/**
 * What fell, and how much of it fell on them.
 *
 * The day's own total is the point of comparison: a day that saw 14 mm and gave
 * the rider 2 of them is a different day from one that gave them all 14, and
 * neither the line above nor the rose says so.
 */
export function RainPanel({
  riding,
  weather,
  distanceM,
}: {
  riding: RidingWeather;
  weather: DayWeather | null;
  distanceM: number;
}) {
  const m = useMessages();
  const km = (metres: number) => (metres / 1000).toFixed(metres < 10000 ? 1 : 0);
  const wet = Math.min(riding.wetM, distanceM);
  const dry = Math.max(0, distanceM - wet);
  const heaviest = Math.max(0, ...riding.hours.map((h) => h.rateMmH));
  const dayTotal = weather?.precipitationMm ?? null;

  return (
    <div className="mt-3 rounded-xl border border-trail bg-paper/60 p-3">
      <p className="text-sm">
        <strong className="font-semibold text-pine">{riding.rainMm.toFixed(1)} mm</strong>
        <span className="text-faint">
          {" · "}
          {m.riding.onTheRider}
          {/* Only worth the comparison when the day held meaningfully more. */}
          {dayTotal !== null && dayTotal > riding.rainMm + 0.5 && (
            <> · {m.riding.dayTotal(dayTotal.toFixed(0))}</>
          )}
        </span>
      </p>

      {distanceM > 0 && (
        <>
          <div className="mt-2 flex h-2 max-w-md overflow-hidden rounded-full bg-trail">
            {wet > 0 && (
              <span style={{ width: `${(wet / distanceM) * 100}%`, backgroundColor: "#5b8ea6" }} />
            )}
            {dry > 0 && (
              <span style={{ width: `${(dry / distanceM) * 100}%`, backgroundColor: "#cbd6cb" }} />
            )}
          </div>
          <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-faint">
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full bg-[#5b8ea6]" />
              {m.riding.wetKm(km(wet))}
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full bg-[#cbd6cb]" />
              {m.riding.dryKm(km(dry))}
            </span>
          </p>
        </>
      )}

      {heaviest > 0 && (
        <p className="mt-2 text-xs text-faint">{m.riding.heaviest(heaviest.toFixed(1))}</p>
      )}
    </div>
  );
}

/** The temperature half of the weather line, as a button. */
export function TemperatureChip({
  riding,
  weather,
  open,
  onToggle,
}: {
  riding: RidingWeather | null;
  weather: DayWeather | null;
  open: boolean;
  onToggle: () => void;
}) {
  const m = useMessages();
  const usable = riding !== null && hasTemperature(riding);
  const label = usable
    ? `${Math.round(riding.tempMinC)}–${Math.round(riding.tempMaxC)}°C`
    : weather?.tempMinC != null && weather?.tempMaxC != null
      ? `${Math.round(weather.tempMinC)}–${Math.round(weather.tempMaxC)}°C`
      : null;
  if (label === null) return null;
  // Without the hourly series there is no panel to open, so it stays plain text
  // rather than a button that does nothing.
  if (!usable) return <>{label}</>;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      title={m.riding.tempChip(Math.round(riding.tempMeanC))}
      className={chipClass(open)}
    >
      {label}
    </button>
  );
}

/** The rain half, which only appears on a day that had any. */
export function RainChip({
  riding,
  weather,
  open,
  onToggle,
}: {
  riding: RidingWeather | null;
  weather: DayWeather | null;
  open: boolean;
  onToggle: () => void;
}) {
  const m = useMessages();
  if (riding) {
    if (riding.rainMm < 0.2) return null;
    return (
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        title={m.riding.rainChip}
        className={chipClass(open)}
      >
        💧 {riding.rainMm.toFixed(1)} mm
      </button>
    );
  }
  if (weather?.precipitationMm == null || weather.precipitationMm <= 0.5) return null;
  return <>💧 {weather.precipitationMm.toFixed(0)} mm</>;
}
