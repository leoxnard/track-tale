import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * A drawer that opens and closes over a quarter of a second instead of
 * appearing whole.
 *
 * The weather chips under a day used to mount their panel outright, and a wind
 * rose or a temperature chart springing into the middle of the page shoves
 * everything below it down in one frame — which reads less like opening a
 * drawer than like the page having jumped.
 *
 * Height is the thing to animate and the thing nobody knows: a rose, a chart
 * and a rain bar are all different heights, and a chart's height depends on the
 * width it ends up with. So rather than measure anything, the drawer is a
 * one-row grid whose row goes from `0fr` to `1fr` — the browser resolves that
 * against the content's own height at both ends and interpolates between them,
 * so nothing here has to know what it is opening. The child needs `min-h-0` for
 * the row to be allowed to be shorter than its content, and `overflow-hidden`
 * so the part that does not fit yet is clipped rather than spilling. Where
 * `grid-template-rows` cannot be interpolated the panel appears at full height
 * as it did before, fading in — no worse than what it replaces.
 *
 * Two things here are less obvious than they look:
 *
 * - **The start of the animation is set imperatively, not through state.** The
 *   collapsed row has to have been through the browser's style resolution
 *   before the expanded one is asked for, or there is nothing to transition
 *   from. Setting `0fr` and then `1fr` across two React renders looks like it
 *   does that and does not: React decides when those renders happen, and it is
 *   free to fold both into a single commit — which it does, so the panel opened
 *   in one frame with the transition never running. Writing both values onto
 *   the node inside one layout effect, with a forced reflow between them, is
 *   the only ordering the browser actually guarantees.
 * - **The children stay mounted until the closing animation has finished**,
 *   which is the whole reason this holds state at all: unmounting them the
 *   moment `open` goes false would leave an empty box to collapse and the panel
 *   would still vanish in one frame.
 */

/** Must match the `duration-` class below — it is what the unmount waits for. */
const DURATION_MS = 250;

export function Collapsible({ open, children }: { open: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(open);
  const unmount = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (unmount.current !== null) {
      window.clearTimeout(unmount.current);
      unmount.current = null;
    }

    // Nothing to animate yet on the pass that decides to open: the node arrives
    // with the next render, and this effect runs again for it.
    if (open && !mounted) {
      setMounted(true);
      return;
    }

    const el = ref.current;
    if (!el) return;

    if (open) {
      el.style.gridTemplateRows = "0fr";
      el.style.opacity = "0";
      // Reading a layout property is what makes the two lines above a state the
      // browser has been in, rather than an edit it never got round to.
      void el.offsetHeight;
      el.style.gridTemplateRows = "1fr";
      el.style.opacity = "1";
      return;
    }

    el.style.gridTemplateRows = "0fr";
    el.style.opacity = "0";
    unmount.current = window.setTimeout(() => {
      unmount.current = null;
      setMounted(false);
    }, DURATION_MS);
  }, [open, mounted]);

  useEffect(
    () => () => {
      if (unmount.current !== null) window.clearTimeout(unmount.current);
    },
    [],
  );

  if (!mounted) return null;

  return (
    <div
      ref={ref}
      className="grid transition-[grid-template-rows,opacity] duration-[250ms] ease-out motion-reduce:transition-none"
      // The open state as the rendered default, so a re-render mid-animation
      // rewrites the value the animation is heading for and nothing else.
      style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}
