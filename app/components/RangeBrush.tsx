import { useCallback, useRef } from "react";
import { useMessages } from "../lib/locale";

interface Props {
  /** Full extent of the axis, in the chart's own units. */
  total: number;
  from: number;
  to: number;
  onChange: (from: number, to: number) => void;
  /** Optional silhouette of the whole route, drawn in a 1000×100 box. */
  backdrop?: string;
  label?: string;
}

/** Keep a graspable window even when the handles are dragged together. */
const MIN_SPAN_RATIO = 0.005;

/**
 * The start/end handles under a chart that set how much of it is on screen.
 *
 * Built from positioned elements rather than inside the SVG: the charts stretch
 * to fit their box, which would smear a handle drawn in chart coordinates into
 * a different width on every screen. These stay the same size — and stay big
 * enough to hit with a thumb — wherever they sit.
 *
 * Pointer events cover mouse and touch in one path, and pointer capture means a
 * drag keeps working after it leaves the handle.
 */
export function RangeBrush({ total, from, to, onChange, backdrop, label }: Props) {
  const m = useMessages();
  const trackRef = useRef<HTMLDivElement>(null);
  const grab = useRef<{ edge: "from" | "to" | "pan"; at: number } | null>(null);

  const valueAt = useCallback(
    (clientX: number): number => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return 0;
      return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * total;
    },
    [total],
  );

  const onPointerDown = (edge: "from" | "to" | "pan") => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    grab.current = { edge, at: valueAt(e.clientX) };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = grab.current;
    if (!g) return;
    const v = valueAt(e.clientX);
    const min = total * MIN_SPAN_RATIO;

    if (g.edge === "from") {
      onChange(Math.min(v, to - min), to);
    } else if (g.edge === "to") {
      onChange(from, Math.max(v, from + min));
    } else {
      // Panning moves both edges together and stops at either end rather than
      // letting the window shrink against the wall.
      const width = to - from;
      let nextFrom = from + (v - g.at);
      if (nextFrom < 0) nextFrom = 0;
      if (nextFrom + width > total) nextFrom = total - width;
      grab.current = { edge: "pan", at: v };
      onChange(nextFrom, nextFrom + width);
    }
  };

  const release = () => {
    grab.current = null;
  };

  const pct = (v: number) => `${(v / total) * 100}%`;

  return (
    <div className="mt-2">
      <div
        ref={trackRef}
        className="relative h-9 touch-none select-none overflow-hidden rounded-md border border-trail bg-paper"
        onPointerMove={onPointerMove}
        onPointerUp={release}
        onPointerCancel={release}
        role="group"
        aria-label={label ?? m.brush.zoomRange}
      >
        {backdrop && (
          <svg
            viewBox="0 0 1000 100"
            preserveAspectRatio="none"
            className="pointer-events-none absolute inset-0 h-full w-full text-faint"
            aria-hidden
          >
            <path d={backdrop} fill="currentColor" opacity={0.45} />
          </svg>
        )}

        {/* Everything outside the window is greyed over, so the window itself is
            the part that reads as lit. */}
        <div className="pointer-events-none absolute inset-y-0 left-0 bg-trail/70" style={{ width: pct(from) }} />
        <div className="pointer-events-none absolute inset-y-0 right-0 bg-trail/70" style={{ width: pct(total - to) }} />

        <div
          className="absolute inset-y-0 cursor-grab active:cursor-grabbing"
          style={{ left: pct(from), width: pct(to - from) }}
          onPointerDown={onPointerDown("pan")}
        />

        {(["from", "to"] as const).map((edge) => (
          <div
            key={edge}
            // A wide, invisible target around a narrow, visible grip.
            className="absolute inset-y-0 flex w-7 -translate-x-1/2 cursor-ew-resize items-center justify-center"
            style={{ left: pct(edge === "from" ? from : to) }}
            onPointerDown={onPointerDown(edge)}
            role="slider"
            aria-label={edge === "from" ? m.brush.rangeStart : m.brush.rangeEnd}
            aria-valuemin={0}
            aria-valuemax={Math.round(total)}
            aria-valuenow={Math.round(edge === "from" ? from : to)}
            tabIndex={0}
          >
            <span className="h-5 w-1.5 rounded-full bg-pine shadow-sm" />
          </div>
        ))}
      </div>
    </div>
  );
}
