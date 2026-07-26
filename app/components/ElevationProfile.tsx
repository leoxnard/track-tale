import { useCallback, useId, useMemo, useRef, useState } from "react";
import type { ProfilePoint } from "../lib/track";
import { useDragZoom } from "./useDragZoom";
import { useMessages } from "../lib/locale";

const W = 720;
const H = 110;
const PAD_TOP = 12;
const PAD_BOTTOM = 16;

interface Props {
  profile: ProfilePoint[];
  color: string;
  /**
   * Metres covered by the chart's height, shared across every day so a given
   * number of pixels means the same climb everywhere. Each day is centred on
   * its own altitude, so charts shift vertically but never rescale.
   */
  span: number;
  /** Move the map marker to the scrubbed position. */
  onScrub?: (point: ProfilePoint) => void;
}

/**
 * Elevation chart for one day. Scrubbing with mouse or finger reports the
 * position back so the map can show where on the route you are.
 *
 * The chart always fits its box — a day is short enough to read whole, and
 * making it scroll sideways only ever got in the way of the finger already
 * being used to scrub it. A mouse can still drag out a stretch to zoom into.
 */
export function ElevationProfile({ profile, color, span, onScrub }: Props) {
  const m = useMessages();
  const svgRef = useRef<SVGSVGElement>(null);
  const clipId = useId();
  const [active, setActive] = useState<number | null>(null);

  const totalD = profile[profile.length - 1]?.d || 1;
  const zoom = useDragZoom(totalD, svgRef);

  const { path, area, minE, maxE, xOf, yOf } = useMemo(() => {
    const es = profile.map((p) => p.e);
    const lo = Math.min(...es);
    const hi = Math.max(...es);

    // The band is the shared span, positioned around this day's own altitude:
    // charts slide up and down the axis but every pixel is the same climb.
    const band = Math.max(span, hi - lo);
    const base = (lo + hi) / 2 - band / 2;

    const viewSpan = zoom.to - zoom.from || 1;
    const x = (d: number) => ((d - zoom.from) / viewSpan) * W;
    const y = (e: number) => PAD_TOP + (1 - (e - base) / band) * (H - PAD_TOP - PAD_BOTTOM);

    const line = profile
      .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.d).toFixed(1)},${y(p.e).toFixed(1)}`)
      .join("");
    const first = x(profile[0]?.d ?? 0).toFixed(1);
    const last = x(profile[profile.length - 1]?.d ?? 0).toFixed(1);

    return {
      path: line,
      area: `${line}L${last},${H - PAD_BOTTOM}L${first},${H - PAD_BOTTOM}Z`,
      minE: lo,
      maxE: hi,
      xOf: x,
      yOf: y,
    };
  }, [profile, span, zoom.from, zoom.to]);

  const move = useCallback(
    (clientX: number) => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      const target = zoom.from + ratio * (zoom.to - zoom.from);

      // profile is sorted by distance, so a scan is fine at ~240 points
      let best = 0;
      let bestGap = Infinity;
      for (let i = 0; i < profile.length; i++) {
        const gap = Math.abs(profile[i].d - target);
        if (gap < bestGap) {
          bestGap = gap;
          best = i;
        }
      }
      setActive(best);
      onScrub?.(profile[best]);
    },
    [onScrub, profile, zoom.from, zoom.to],
  );

  if (profile.length < 2) return null;

  const cur = active !== null ? profile[active] : null;
  const sel = zoom.selection;

  return (
    <figure className="mt-3">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-[110px] w-full touch-none select-none"
        role="img"
        aria-label={m.elevation.aria(
          Math.round(minE),
          Math.round(maxE),
          (totalD / 1000).toFixed(1),
        )}
        onMouseDown={(e) => zoom.start(e.clientX)}
        onMouseMove={(e) => {
          // While a range is being dragged out, the pointer is choosing a zoom
          // rather than reading a position.
          if (!zoom.extend(e.clientX)) move(e.clientX);
        }}
        onMouseUp={() => zoom.commit()}
        onMouseLeave={() => zoom.cancel()}
        onTouchStart={(e) => move(e.touches[0].clientX)}
        onTouchMove={(e) => move(e.touches[0].clientX)}
      >
        <defs>
          <clipPath id={clipId}>
            <rect x={0} y={0} width={W} height={H} />
          </clipPath>
        </defs>

        <g clipPath={`url(#${clipId})`}>
          <path d={area} fill={color} opacity={0.16} />
          <path d={path} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
          {cur && (
            <g>
              <line
                x1={xOf(cur.d)}
                x2={xOf(cur.d)}
                y1={PAD_TOP}
                y2={H - PAD_BOTTOM}
                stroke={color}
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
              <circle cx={xOf(cur.d)} cy={yOf(cur.e)} r={4} fill={color} stroke="#fff" strokeWidth={1.5} />
            </g>
          )}
        </g>

        {sel && (
          <rect
            x={sel[0] * W}
            y={PAD_TOP}
            width={(sel[1] - sel[0]) * W}
            height={H - PAD_TOP - PAD_BOTTOM}
            fill={color}
            opacity={0.18}
          />
        )}
      </svg>

      <figcaption className="mt-1 flex items-baseline justify-between gap-x-3 text-xs text-faint">
        {cur ? (
          <>
            <span>{(cur.d / 1000).toFixed(1)} km</span>
            <span>{Math.round(cur.e)} m</span>
          </>
        ) : (
          <>
            <span>
              {Math.round(minE)}–{Math.round(maxE)} m
            </span>
            <span className="opacity-70">
              <span className="hidden sm:inline">{m.profile.dragToZoom}</span>
              {m.elevation.dragAlong}
            </span>
          </>
        )}
        {zoom.zoomed && (
          <button
            type="button"
            onClick={zoom.reset}
            className="shrink-0 rounded-full border border-trail px-2 py-0.5 font-bold text-pine hover:border-pine-soft focus-visible:outline-2 focus-visible:outline-pine"
          >
            {m.elevation.resetZoom}
          </button>
        )}
      </figcaption>
    </figure>
  );
}
