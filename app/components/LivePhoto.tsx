import { useEffect, useRef } from "react";
import { useLiveMotion } from "./live-motion";

/**
 * A photo in the day's grid, which plays if it has three seconds behind it.
 *
 * An iPhone plays a Live Photo when you press and hold it, and that gesture is
 * what this offers back: hold a finger on the tile and it plays, without the
 * photo opening full screen when the finger lifts and without iOS's own
 * press-and-hold menu appearing over the top. A mouse gets the same thing by
 * pointing, which is the desktop's version of dwelling on something.
 *
 * Scrolling one into the middle of the screen also plays it, once. That is the
 * part that makes the feature findable at all — nobody long-presses a photo to
 * see whether it might move — and the hold is then how you watch it again.
 *
 * The still stays underneath the whole time rather than being swapped out. A
 * video takes a moment to decode its first frame, and cross-fading over a
 * picture that is already there is the difference between a photo that comes
 * alive and a tile that blinks empty.
 */

interface Props {
  stillUrl: string;
  /** The motion behind the still, or null for an ordinary photo. */
  motionUrl: string | null;
  alt: string;
  /** Shown in the corner while the still is up, so a Live Photo announces itself. */
  liveLabel: string;
  /** Applied to the frame both the still and the motion fill. */
  className?: string;
}

/**
 * How much of the tile has to be on screen before it plays itself.
 *
 * High on purpose: on a phone the grid is two columns, and a threshold that
 * caught everything half in view would set four videos going at once on what
 * is, on this trip, one bar of signal in a valley.
 */
const PLAY_VISIBILITY = 0.75;

export function LivePhoto({ stillUrl, motionUrl, alt, liveLabel, className }: Props) {
  // Not with the mouse: the tile is a link, and a slow click still has to open
  // the photo rather than being eaten as a hold. Pointing plays it instead.
  const { videoRef, playing, start, stop, press } = useLiveMotion({ holdWithMouse: false });
  const frameRef = useRef<HTMLDivElement>(null);

  // The phone half. Only where there is no pointer: on a desktop this would
  // fight the hover and play everything the moment the page settled.
  useEffect(() => {
    const frame = frameRef.current;
    if (!motionUrl || !frame) return;
    if (window.matchMedia("(hover: hover)").matches) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const observer = new IntersectionObserver(
      ([entry]) => (entry.isIntersecting ? start() : stop()),
      { threshold: PLAY_VISIBILITY },
    );
    observer.observe(frame);
    return () => observer.disconnect();
  }, [motionUrl, start, stop]);

  if (!motionUrl) {
    return (
      <div className={`relative overflow-hidden ${className ?? ""}`}>
        <img src={stillUrl} alt={alt} loading="lazy" className="h-full w-full object-cover" />
      </div>
    );
  }

  return (
    <div
      ref={frameRef}
      // `touch-callout` and `select-none` are what stop iOS putting its own
      // "open link" sheet over the video the gesture is trying to play. Only on
      // a tile with motion — a plain photo keeps its ordinary long-press menu.
      className={`relative select-none overflow-hidden [-webkit-touch-callout:none] ${className ?? ""}`}
      // The pointer is read off the frame, not the video: the video sits behind
      // `pointer-events: none` so it never swallows the click that opens the
      // photo full size.
      onPointerEnter={(e) => {
        if (e.pointerType === "mouse") start();
      }}
      {...press}
    >
      <img
        src={stillUrl}
        alt={alt}
        loading="lazy"
        className="h-full w-full object-cover transition-opacity duration-200"
        // Fading the still out rather than leaving it under an opaque video
        // keeps the swap from showing a seam where the two do not line up to
        // the pixel, which happens whenever a re-encode changed the crop.
        style={playing ? { opacity: 0 } : undefined}
      />
      <video
        ref={videoRef}
        src={motionUrl}
        muted
        playsInline
        preload="none"
        onEnded={stop}
        aria-hidden="true"
        className={`pointer-events-none absolute inset-0 h-full w-full object-cover transition-opacity duration-200 ${
          playing ? "opacity-100" : "opacity-0"
        }`}
      />
      <span
        className={`pointer-events-none absolute left-1.5 top-1.5 rounded bg-black/45 px-1.5 py-px text-[0.6rem] font-medium uppercase tracking-wider text-white transition-opacity ${
          playing ? "opacity-0" : "opacity-90"
        }`}
      >
        {liveLabel}
      </span>
    </div>
  );
}
