import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useMessages } from "../lib/locale";

/**
 * The trip's own menu, beside the share button in the header.
 *
 * Everything the family page offers is *about* the days — a menu is where the
 * things that are about the trip as a whole go, starting with the download
 * centre and with room for a packing list and whatever else follows. Adding one
 * is a line in `items` below plus its own route; nothing here knows what the
 * entries are for.
 *
 * Deliberately not a `<details>`: the panel has to close when a finger lands
 * anywhere else on the page, and closing a `details` from the outside means
 * reaching into it anyway.
 *
 * It grows out of the button rather than appearing whole — a short fade with
 * the panel rising the last few pixels into place and scaled from its top
 * right, which is the corner it hangs from. Two details make that work:
 *
 * - **The first frame is written imperatively.** The hidden state has to have
 *   been through the browser's style resolution before the shown one is asked
 *   for, and setting one and then the other across two React renders does not
 *   guarantee that: React is free to fold both into a single commit, and does,
 *   leaving the panel to appear in one frame with the transition never running.
 * - **The panel outlives its own closing.** Unmounting it the moment `open`
 *   goes false would take the animation with it, so it stays until the
 *   transition it was given has had time to finish.
 *
 * The same reasoning, and the same two traps, as `Collapsible` — but a popup
 * hangs from a corner and needs no height to be interpolated, so it does not
 * borrow that component's grid.
 */

export interface TripMenuItem {
  to: string;
  label: string;
}

/** Must match the `duration-` class below — it is what the unmount waits for. */
const DURATION_MS = 140;

/** What the panel looks like before it is there, and again once it is going. */
const HIDDEN = { opacity: "0", transform: "translateY(-4px) scale(0.96)" };
const SHOWN = { opacity: "1", transform: "translateY(0) scale(1)" };

export function TripMenu({ slug, className = "" }: { slug: string; className?: string }) {
  const m = useMessages();
  const [open, setOpen] = useState(false);
  // Whether the panel is in the document, which lags `open` by the length of
  // the closing animation.
  const [mounted, setMounted] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const unmount = useRef<number | null>(null);

  const items: TripMenuItem[] = [{ to: `/t/${slug}/downloads`, label: m.menu.downloads }];

  useLayoutEffect(() => {
    if (unmount.current !== null) {
      window.clearTimeout(unmount.current);
      unmount.current = null;
    }

    // Nothing to animate yet on the pass that decides to open: the panel
    // arrives with the next render, and this effect runs again for it.
    if (open && !mounted) {
      setMounted(true);
      return;
    }

    const el = panel.current;
    if (!el) return;

    if (open) {
      Object.assign(el.style, HIDDEN);
      // Reading a layout property is what makes the line above a state the
      // browser has been in, rather than an edit it never got round to.
      void el.offsetHeight;
      Object.assign(el.style, SHOWN);
      return;
    }

    Object.assign(el.style, HIDDEN);
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

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // Capture, so a tap that opens something else closes this on the way past.
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={box} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-label={m.menu.label}
        title={m.menu.label}
        aria-expanded={open}
        aria-haspopup="menu"
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-trail text-pine transition hover:border-pine-soft hover:bg-trail/30 focus-visible:outline-2 focus-visible:outline-pine"
      >
        <svg
          viewBox="0 0 24 24"
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>

      {mounted && (
        <div
          ref={panel}
          role="menu"
          className="absolute right-0 z-30 mt-2 min-w-52 origin-top-right overflow-hidden rounded-xl border border-trail bg-paper py-1 shadow-lg transition-[opacity,transform] duration-[140ms] ease-out motion-reduce:transition-none"
          // The open state as the rendered default, so a re-render mid-animation
          // rewrites the value the animation is heading for and nothing else.
          style={open ? SHOWN : HIDDEN}
        >
          {items.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              role="menuitem"
              onClick={() => setOpen(false)}
              className="block px-4 py-2 text-sm text-pine transition hover:bg-trail/40 focus-visible:outline-2 focus-visible:outline-pine"
            >
              {item.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
