import { useCallback, useMemo, useRef, useState } from "react";
import type { ProfilePoint } from "../lib/track";

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
 */
export function ElevationProfile({ profile, color, span, onScrub }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [active, setActive] = useState<number | null>(null);

  const { path, area, minE, maxE, totalD, yOf } = useMemo(() => {
    const es = profile.map((p) => p.e);
    const lo = Math.min(...es);
    const hi = Math.max(...es);
    const total = profile[profile.length - 1]?.d || 1;

    // The band is the shared span, positioned around this day's own altitude:
    // charts slide up and down the axis but every pixel is the same climb.
    const band = Math.max(span, hi - lo);
    const base = (lo + hi) / 2 - band / 2;

    const x = (p: ProfilePoint) => (p.d / total) * W;
    const y = (p: ProfilePoint) =>
      PAD_TOP + (1 - (p.e - base) / band) * (H - PAD_TOP - PAD_BOTTOM);

    const line = profile.map((p, i) => `${i === 0 ? "M" : "L"}${x(p).toFixed(1)},${y(p).toFixed(1)}`).join("");
    return {
      path: line,
      area: `${line}L${W},${H - PAD_BOTTOM}L0,${H - PAD_BOTTOM}Z`,
      minE: lo,
      maxE: hi,
      totalD: total,
      yOf: y,
    };
  }, [profile, span]);

  const indexAt = useCallback(
    (clientX: number): number | null => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return null;
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      const target = ratio * totalD;
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
      return best;
    },
    [profile, totalD],
  );

  const move = useCallback(
    (clientX: number) => {
      const i = indexAt(clientX);
      if (i === null) return;
      setActive(i);
      onScrub?.(profile[i]);
    },
    [indexAt, onScrub, profile],
  );

  if (profile.length < 2) return null;

  const cur = active !== null ? profile[active] : null;
  const curX = cur ? (cur.d / totalD) * W : 0;
  const curY = cur ? yOf(cur) : 0;

  return (
    <figure className="mt-3">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-[110px] w-full touch-none select-none"
        role="img"
        aria-label={`Elevation profile: ${Math.round(minE)} to ${Math.round(maxE)} metres over ${(totalD / 1000).toFixed(1)} kilometres`}
        onMouseMove={(e) => move(e.clientX)}
        onTouchStart={(e) => move(e.touches[0].clientX)}
        onTouchMove={(e) => move(e.touches[0].clientX)}
      >
        <path d={area} fill={color} opacity={0.16} />
        <path d={path} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
        {cur && (
          <g>
            <line
              x1={curX}
              x2={curX}
              y1={PAD_TOP}
              y2={H - PAD_BOTTOM}
              stroke={color}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            <circle cx={curX} cy={curY} r={4} fill={color} stroke="#fff" strokeWidth={1.5} />
          </g>
        )}
      </svg>
      <figcaption className="mt-1 flex justify-between text-xs text-faint">
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
            <span className="opacity-70">drag along the line to follow the route</span>
          </>
        )}
      </figcaption>
    </figure>
  );
}
