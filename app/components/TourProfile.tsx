import { useCallback, useMemo, useRef, useState } from "react";
import { buildProfile, fromGeoJson, haversineM, type ProfilePoint, type TrackGeoJson } from "../lib/track";

const W = 960;
const H = 200;
const PAD_TOP = 14;
const PAD_BOTTOM = 22;
const PLOT_H = H - PAD_TOP - PAD_BOTTOM;

const PLAN_COLOR = "#9aa59e";

export interface TourDayInput {
  dayNumber: number;
  color: string;
  distanceM: number;
  profile: ProfilePoint[];
}

interface Props {
  /** Planned route, already on the page for the map — re-used here as the grey line. */
  plan: TrackGeoJson[];
  /** Authoritative planned distance in km; the drawn plan is stretched to match it. */
  planKm: number;
  days: TourDayInput[];
  /** Move the map marker to the scrubbed position. */
  onScrub?: (point: ProfilePoint, color: string) => void;
  /** Take the map marker away again when the pointer leaves the chart. */
  onScrubEnd?: () => void;
  /** Jump the map and the page to a day when its part of the line is clicked. */
  onSelectDay?: (dayNumber: number) => void;
}

interface LaidDay extends TourDayInput {
  startM: number;
  endM: number;
  points: ProfilePoint[];
}

/**
 * Past this, the nearest planned coordinate to a day's endpoint is too far away
 * to mean anything — a rest day in a city, or a plan that was abandoned.
 */
const MAX_ANCHOR_GAP_M = 25_000;

/** Round tick spacing that lands on a value people read without thinking. */
const TICK_STEPS = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];

function tickStep(range: number): number {
  const target = range / 4;
  return TICK_STEPS.find((s) => s >= target) ?? TICK_STEPS[TICK_STEPS.length - 1];
}

/**
 * Fractions along a day's own profile used to anchor it to the plan.
 * Deliberately excludes 0 and 1: the start and end of a day are often off
 * the planned route (a bed for the night rarely sits on the tour line),
 * while the middle of the day is usually still on it.
 */
const ANCHOR_FRACTIONS = [0.25, 0.5, 0.75];

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * One elevation chart for the whole journey: the planned route as a grey
 * backdrop, with each ridden day laid over the stretch of the route it covers.
 * Days sit end to end by distance, so the coloured line stops exactly where
 * the traveller has got to and the grey line ahead is what's left.
 */
export function TourProfile({ plan, planKm, days, onScrub, onScrubEnd, onSelectDay }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [active, setActive] = useState<{ d: number; e: number; color: string; day: number | null } | null>(
    null,
  );

  const chart = useMemo(() => {
    const planPoints = buildProfile(plan.flatMap(fromGeoJson), 600);
    const planSpan = planPoints[planPoints.length - 1]?.d ?? 0;
    const planM = planKm * 1000 || planSpan;
    const planLine =
      planPoints.length > 1 && planSpan > 0
        ? planPoints.map((p) => ({ ...p, d: (p.d / planSpan) * planM }))
        : [];

    /** How far along the plan the nearest planned point to this coordinate sits. */
    const anchorOf = (p: ProfilePoint): { d: number; gap: number } | null => {
      if (planLine.length === 0) return null;
      let best = planLine[0];
      let bestGap = Infinity;
      for (const q of planLine) {
        const gap = haversineM(q, p);
        if (gap < bestGap) {
          bestGap = gap;
          best = q;
        }
      }
      return { d: best.d, gap: bestGap };
    };

    // Each day is pinned to where it actually ran along the plan rather than
    // stacked behind the day before it, so one detour or shortcut no longer
    // shifts every following day. The day keeps its own length, and it's
    // anchored from a few points partway through it — the median of their
    // offsets positions it. Days may then overlap or leave a gap, which is
    // exactly the shortcut or detour showing up.
    const laid: LaidDay[] = [];
    let cursor = 0;
    let riddenM = 0;
    for (const day of days) {
      const span = day.profile[day.profile.length - 1]?.d ?? 0;
      const width = day.distanceM > 0 ? day.distanceM : span;
      riddenM += width;
      if (day.profile.length < 2 || width <= 0) {
        cursor += width;
        continue;
      }

      const offsets: number[] = [];
      for (const f of ANCHOR_FRACTIONS) {
        const idx = Math.round(f * (day.profile.length - 1));
        const p = day.profile[idx];
        const anchor = anchorOf(p);
        if (anchor && anchor.gap < MAX_ANCHOR_GAP_M) offsets.push(anchor.d - p.d);
      }
      // A day that never came near the plan can't be anchored to it; fall back
      // to sitting behind the previous day.
      const startM = offsets.length > 0 ? Math.max(0, median(offsets)) : cursor;

      laid.push({
        ...day,
        startM,
        endM: startM + width,
        points: day.profile.map((p) => ({ ...p, d: startM + (p.d / (span || 1)) * width })),
      });
      cursor = startM + width;
    }

    // The furthest point reached along the plan, which with anchoring is not the
    // same as the total distance ridden.
    const reachedM = laid.reduce((m, d) => Math.max(m, d.endM), 0);
    const totalM = Math.max(planM, reachedM, 1);

    const es = [...planLine.map((p) => p.e), ...laid.flatMap((d) => d.points.map((p) => p.e))];
    if (es.length === 0) return null;
    const lo = Math.min(...es);
    const hi = Math.max(...es);
    const pad = Math.max(5, (hi - lo) * 0.08);
    const base = lo - pad;
    const band = hi + pad - base || 1;

    const x = (d: number) => (d / totalM) * W;
    const y = (e: number) => PAD_TOP + (1 - (e - base) / band) * PLOT_H;

    const toPath = (pts: ProfilePoint[]) =>
      pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.d).toFixed(1)},${y(p.e).toFixed(1)}`).join("");

    const step = tickStep(band);
    const ticks: number[] = [];
    for (let t = Math.ceil(base / step) * step; t < base + band; t += step) ticks.push(t);

    return {
      laid,
      planLine,
      planPath: toPath(planLine),
      planArea: planLine.length > 1 ? `${toPath(planLine)}L${x(planM)},${H - PAD_BOTTOM}L0,${H - PAD_BOTTOM}Z` : "",
      riddenM,
      reachedM,
      planM,
      totalM,
      ticks,
      x,
      y,
    };
  }, [plan, planKm, days]);

  const move = useCallback(
    (clientX: number) => {
      if (!chart) return;
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      const target = ratio * chart.totalM;

      // Prefer the ridden line where there is one; fall back to the plan ahead.
      const day = chart.laid.find((d) => target >= d.startM && target <= d.endM);
      const pts = day ? day.points : chart.planLine;
      if (pts.length === 0) return;
      let best = pts[0];
      let bestGap = Infinity;
      for (const p of pts) {
        const gap = Math.abs(p.d - target);
        if (gap < bestGap) {
          bestGap = gap;
          best = p;
        }
      }
      const color = day?.color ?? PLAN_COLOR;
      setActive({ d: best.d, e: best.e, color, day: day?.dayNumber ?? null });
      onScrub?.(best, color);
    },
    [chart, onScrub],
  );

  if (!chart) return null;

  const { laid, planPath, planArea, riddenM, reachedM, planM, totalM, ticks, x, y } = chart;
  const aheadX = x(reachedM);

  return (
    <section
      id="tour-profile"
      className="scroll-mt-[calc(38dvh+3.5rem)] rounded-xl border border-trail bg-paper p-4 sm:scroll-mt-[calc(48dvh+3.5rem)]"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="font-display text-lg font-semibold text-pine">The whole tour</h2>
        <p className="text-xs text-faint">
          <span className="inline-block h-0.5 w-4 translate-y-[-3px] bg-[#9aa59e] align-middle" /> planned
          {planM > 0 && <> · {(planM / 1000).toFixed(0)} km</>}
          {riddenM > 0 && <> · {(riddenM / 1000).toFixed(0)} km ridden</>}
        </p>
      </div>

      <div className="mt-3 overflow-x-auto">
        <div className="relative" style={{ width: W, minWidth: W }}>
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            className="h-44 w-full touch-none select-none sm:h-56"
            role="img"
            aria-label={`Elevation of the whole tour: ${(riddenM / 1000).toFixed(0)} of ${(planM / 1000).toFixed(0)} kilometres ridden`}
            onMouseMove={(e) => move(e.clientX)}
            onMouseLeave={() => {
              setActive(null);
              onScrubEnd?.();
            }}
            onTouchStart={(e) => move(e.touches[0].clientX)}
            onTouchMove={(e) => move(e.touches[0].clientX)}
            onClick={() => {
              if (active?.day != null) onSelectDay?.(active.day);
            }}
          >
            {ticks.map((t) => (
              <line
                key={t}
                x1={0}
                x2={W}
                y1={y(t)}
                y2={y(t)}
                stroke="currentColor"
                className="text-trail"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            ))}
  
            {planArea && <path d={planArea} fill={PLAN_COLOR} opacity={0.12} />}
            {planPath && (
              <path
                d={planPath}
                fill="none"
                stroke={PLAN_COLOR}
                strokeWidth={1.5}
                strokeDasharray="4 3"
                vectorEffect="non-scaling-stroke"
              />
            )}
  
            {laid.map((day) => (
              <g key={day.dayNumber}>
                <path
                  d={`${day.points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.d).toFixed(1)},${y(p.e).toFixed(1)}`).join("")}L${x(day.endM).toFixed(1)},${H - PAD_BOTTOM}L${x(day.startM).toFixed(1)},${H - PAD_BOTTOM}Z`}
                  fill={day.color}
                  opacity={0.14}
                />
                <path
                  d={day.points
                    .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.d).toFixed(1)},${y(p.e).toFixed(1)}`)
                    .join("")}
                  fill="none"
                  stroke={day.color}
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                />
                {/* Day boundary. The first day starts at the axis, which needs no line. */}
                {day.startM > 0 && (
                  <line
                    x1={x(day.startM)}
                    x2={x(day.startM)}
                    y1={PAD_TOP}
                    y2={H - PAD_BOTTOM}
                    stroke={day.color}
                    strokeWidth={1}
                    opacity={0.35}
                    vectorEffect="non-scaling-stroke"
                  />
                )}
              </g>
            ))}
  
            {/* Where the traveller has got to. */}
            {reachedM > 0 && reachedM < totalM && (
              <line
                x1={aheadX}
                x2={aheadX}
                y1={PAD_TOP}
                y2={H - PAD_BOTTOM}
                stroke="currentColor"
                className="text-faint"
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
              />
            )}
  
            {active && (
              <g>
                <line
                  x1={x(active.d)}
                  x2={x(active.d)}
                  y1={PAD_TOP}
                  y2={H - PAD_BOTTOM}
                  stroke={active.color}
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
                <circle cx={x(active.d)} cy={y(active.e)} r={4} fill={active.color} stroke="#fff" strokeWidth={1.5} />
              </g>
            )}
          </svg>

          {/* Axis labels live outside the SVG: the chart is stretched to fit its
              box, which would squash any text drawn inside it. Elevation labels
              are sticky so they stay on screen while the chart scrolls
              horizontally; day numbers scroll with the chart since they mark a
              position along it. */}
          <div className="pointer-events-none absolute inset-0">
            {ticks.map((t) => (
              <span
                key={t}
                className="absolute inset-x-0 -translate-y-1/2"
                style={{ top: `${(y(t) / H) * 100}%` }}
              >
                <span className="sticky left-0 bg-paper pr-1 text-[10px] leading-none text-faint">
                  {Math.round(t)} m
                </span>
              </span>
            ))}
            {laid.map((day) => (
              <span
                key={day.dayNumber}
                className="absolute bottom-0 text-[10px] font-bold leading-none"
                style={{ left: `${(x(day.startM) / W) * 100}%`, color: day.color }}
              >
                {day.dayNumber}
              </span>
            ))}
          </div>
        </div>
      </div>

      <p className="mt-1 flex flex-wrap justify-between gap-x-4 text-xs text-faint">
        {active ? (
          <>
            <span>
              {(active.d / 1000).toFixed(1)} km · {Math.round(active.e)} m
              {active.day !== null && <> · day {active.day}</>}
            </span>
            {active.day !== null && <span className="opacity-70">tap to jump to that day</span>}
          </>
        ) : (
          <>
            <span>0 – {(totalM / 1000).toFixed(0)} km along the planned route</span>
            <span className="opacity-70">drag along the line to follow the route</span>
          </>
        )}
      </p>
    </section>
  );
}
