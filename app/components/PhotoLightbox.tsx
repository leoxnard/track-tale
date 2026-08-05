import { useCallback, useEffect, useRef } from "react";
import { useMessages } from "../lib/locale";

/**
 * Full-screen viewer for the trip's photos.
 *
 * The gallery used to be plain links, so tapping a photo navigated away from
 * the trip to a bare image URL and the only way back was the browser's back
 * button — and seeing the next photo meant going back and tapping again. This
 * keeps the page where it is and makes the whole trip one sequence to walk
 * through, from the grid or from a marker on the map.
 *
 * The links stay real links underneath, so opening a photo in a new tab and
 * saving it still work; this only takes over the plain click.
 */

export interface LightboxPhoto {
  url: string;
  thumbUrl: string;
  caption: string | null;
  author: string | null;
  dayNumber: number;
}

interface Props {
  photos: LightboxPhoto[];
  /** Which photo is open, or null when the viewer is closed. */
  index: number | null;
  onIndex: (index: number) => void;
  onClose: () => void;
  /** Names are only worth showing when more than one person contributed. */
  showAuthors: boolean;
}

export function PhotoLightbox({ photos, index, onIndex, onClose, showAuthors }: Props) {
  const m = useMessages();
  const dialogRef = useRef<HTMLDivElement>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const open = index !== null && photos[index] !== undefined;

  // Wrapping round is what makes a long day's gallery pleasant to page through
  // — you never hit an end that just stops responding.
  const step = useCallback(
    (by: number) => {
      if (index === null || photos.length === 0) return;
      onIndex((index + by + photos.length) % photos.length);
    },
    [index, onIndex, photos.length],
  );

  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case "Escape":
          onClose();
          break;
        case "ArrowRight":
          e.preventDefault();
          step(1);
          break;
        case "ArrowLeft":
          e.preventDefault();
          step(-1);
          break;
        // The keys anyone who has used a photo viewer reaches for next.
        case "Home":
          e.preventDefault();
          onIndex(0);
          break;
        case "End":
          e.preventDefault();
          onIndex(photos.length - 1);
          break;
      }
    };
    window.addEventListener("keydown", onKey);

    // The page behind must not scroll under the overlay, and the arrow keys
    // have to reach the dialog rather than whatever was focused before it.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const previouslyFocused = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();

    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, [open, onClose, onIndex, step, photos.length]);

  // Fetch the neighbours while this one is being looked at, so paging through
  // a day doesn't blink on every step.
  useEffect(() => {
    if (index === null) return;
    for (const offset of [1, -1]) {
      const neighbour = photos[(index + offset + photos.length) % photos.length];
      if (neighbour) new Image().src = neighbour.url;
    }
  }, [index, photos]);

  if (!open) return null;
  const photo = photos[index];
  const caption = [photo.caption, showAuthors && photo.author ? photo.author : null]
    .filter(Boolean)
    .join(" — ");

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={m.lightbox.label}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex flex-col bg-black/95 outline-none backdrop-blur-sm"
      onClick={onClose}
      onTouchStart={(e) => {
        touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }}
      onTouchEnd={(e) => {
        const from = touchStart.current;
        touchStart.current = null;
        if (!from) return;
        const dx = e.changedTouches[0].clientX - from.x;
        const dy = e.changedTouches[0].clientY - from.y;
        // Mostly-horizontal and far enough to be a swipe rather than a tap.
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1);
      }}
    >
      <div className="flex shrink-0 items-center justify-between gap-4 px-4 py-3 text-sm text-white/80">
        <span>
          {m.trip.day(photo.dayNumber)} · {m.lightbox.position(index + 1, photos.length)}
        </span>
        <span className="hidden opacity-60 sm:inline">{m.lightbox.hint}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label={m.lightbox.close}
          className="-mr-1 rounded-full px-3 py-1 text-2xl leading-none hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white"
        >
          ×
        </button>
      </div>

      {/* Clicks inside the frame belong to the photo and its controls; only the
          backdrop closes. */}
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center px-2 pb-2"
        onClick={(e) => e.stopPropagation()}
      >
        {photos.length > 1 && (
          <button
            type="button"
            onClick={() => step(-1)}
            aria-label={m.lightbox.previous}
            className="absolute left-1 z-10 rounded-full bg-black/40 px-3 py-4 text-2xl leading-none text-white hover:bg-black/70 focus-visible:outline-2 focus-visible:outline-white sm:left-3"
          >
            ‹
          </button>
        )}

        <img
          key={photo.url}
          src={photo.url}
          alt={photo.caption ?? m.trip.photoAlt(photo.dayNumber)}
          className="max-h-full max-w-full object-contain"
        />

        {photos.length > 1 && (
          <button
            type="button"
            onClick={() => step(1)}
            aria-label={m.lightbox.next}
            className="absolute right-1 z-10 rounded-full bg-black/40 px-3 py-4 text-2xl leading-none text-white hover:bg-black/70 focus-visible:outline-2 focus-visible:outline-white sm:right-3"
          >
            ›
          </button>
        )}
      </div>

      <div
        className="shrink-0 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-1 text-center text-sm text-white/85"
        onClick={(e) => e.stopPropagation()}
      >
        {caption && <p className="mx-auto max-w-prose">{caption}</p>}
        <a
          href={photo.url}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-block text-xs text-white/50 underline underline-offset-2 hover:text-white"
        >
          {m.lightbox.openOriginal}
        </a>
      </div>
    </div>
  );
}
