import { useCallback, useRef } from "react";

/**
 * Horizontal scrolling for a chart that has already claimed one finger.
 *
 * The charts set `touch-action: none` so a single-finger drag follows the line
 * instead of moving the page — which also takes the browser's own panning away,
 * leaving the overflow container unreachable by touch. This hands scrolling
 * back to a two-finger gesture, the same bargain the map strikes with
 * MapLibre's cooperative gestures.
 *
 * Attach `handlers` to the element that wraps the scroll container: touch
 * events from the chart bubble up to it, so both gestures are read in one
 * place. Scrubbing stays the caller's job — it should ignore any touch with
 * more than one finger down.
 */
export function useChartScroll() {
  const ref = useRef<HTMLDivElement>(null);
  const lastX = useRef<number | null>(null);

  const midpointX = (touches: React.TouchList) =>
    (touches[0].clientX + touches[1].clientX) / 2;

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    lastX.current = e.touches.length >= 2 ? midpointX(e.touches) : null;
  }, []);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (e.touches.length < 2 || !ref.current) return;
    const x = midpointX(e.touches);
    // The first move after the second finger lands only establishes a origin.
    if (lastX.current !== null) ref.current.scrollLeft -= x - lastX.current;
    lastX.current = x;
  }, []);

  // Lifting back down to one finger would otherwise jump the chart by the gap
  // between the midpoint and the remaining finger.
  const onTouchEnd = useCallback((e: React.TouchEvent) => {
    lastX.current = e.touches.length >= 2 ? midpointX(e.touches) : null;
  }, []);

  return { ref, handlers: { onTouchStart, onTouchMove, onTouchEnd } };
}
