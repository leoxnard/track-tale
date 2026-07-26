import { useCallback, useRef, useState } from "react";

/**
 * A drag shorter than this much of the chart's width was someone clicking, not
 * someone selecting a range — so it zooms nothing and the click stands.
 */
const MIN_DRAG_RATIO = 0.015;

/** Never zoom so far that the window has nothing left in it. */
const MIN_SPAN_RATIO = 0.005;

/**
 * Zooming a chart's x-axis by dragging a range across it with the mouse.
 *
 * Deliberately mouse-only. A finger is already spoken for — it scrubs the line
 * — and there is no second gesture left on touch that doesn't fight the first,
 * which is what made scrolling these charts by touch such a mess. Touch devices
 * get the range brush instead, which has its own handles to drag.
 *
 * The window is kept in the chart's own units (metres here) rather than pixels,
 * so it survives the chart being resized underneath it.
 */
export function useDragZoom(total: number, elementRef: React.RefObject<Element | null>) {
  const [view, setView] = useState<[number, number] | null>(null);
  const [drag, setDrag] = useState<[number, number] | null>(null);
  const dragging = useRef(false);

  const [from, to] = view ?? [0, total];

  const ratioAt = useCallback(
    (clientX: number): number | null => {
      const rect = elementRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return null;
      return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    },
    [elementRef],
  );

  const start = useCallback(
    (clientX: number) => {
      const r = ratioAt(clientX);
      if (r === null) return;
      dragging.current = true;
      setDrag([r, r]);
    },
    [ratioAt],
  );

  /** True once this is a drag, telling the caller to hold off on scrubbing. */
  const extend = useCallback(
    (clientX: number): boolean => {
      if (!dragging.current) return false;
      const r = ratioAt(clientX);
      if (r !== null) setDrag((d) => (d ? [d[0], r] : null));
      return true;
    },
    [ratioAt],
  );

  /** True when the gesture zoomed, so the caller can let the click that follows go by. */
  const commit = useCallback((): boolean => {
    if (!dragging.current) return false;
    dragging.current = false;
    setDrag(null);
    if (!drag) return false;

    const lo = Math.min(drag[0], drag[1]);
    const hi = Math.max(drag[0], drag[1]);
    if (hi - lo < MIN_DRAG_RATIO) return false;

    const span = to - from;
    const next: [number, number] = [from + lo * span, from + hi * span];
    if (next[1] - next[0] < total * MIN_SPAN_RATIO) return false;
    setView(next);
    return true;
  }, [drag, from, to, total]);

  const cancel = useCallback(() => {
    dragging.current = false;
    setDrag(null);
  }, []);

  const reset = useCallback(() => setView(null), []);

  const setWindow = useCallback(
    (nextFrom: number, nextTo: number) => {
      setView([Math.max(0, nextFrom), Math.min(total, nextTo)]);
    },
    [total],
  );

  return {
    from,
    to,
    zoomed: view !== null,
    /** Ratios across the *current* view, for painting the selection band. */
    selection: drag ? ([Math.min(...drag), Math.max(...drag)] as [number, number]) : null,
    start,
    extend,
    commit,
    cancel,
    reset,
    setWindow,
  };
}
