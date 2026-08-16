import { useEffect, useRef, useState } from "react";
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
 */

export interface TripMenuItem {
  to: string;
  label: string;
}

export function TripMenu({ slug, className = "" }: { slug: string; className?: string }) {
  const m = useMessages();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);

  const items: TripMenuItem[] = [{ to: `/t/${slug}/downloads`, label: m.menu.downloads }];

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

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-2 min-w-52 overflow-hidden rounded-xl border border-trail bg-paper py-1 shadow-lg"
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
