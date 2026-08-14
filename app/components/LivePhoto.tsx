import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A photo in the day's grid, which plays if it has three seconds behind it.
 *
 * An iPhone plays a Live Photo when you press and hold it. There is no press
 * and hold on a web page, and inventing one would mean fighting the browser's
 * own long-press menu, so the motion is triggered by the two things people
 * already do to a photo grid: point at a picture, or scroll it into the middle
 * of the screen. Pointing is the desktop half; scrolling is the phone half,
 * where there is no pointer at all and a picture that never played would leave
 * the whole feature invisible to most of the family.
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
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);

  const start = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = 0;
    // Autoplay is refused often enough — a muted inline video is normally
    // allowed, but not always — and a rejected promise here is not an error
    // worth anyone's console: the still is a perfectly good photograph.
    void video.play().then(
      () => setPlaying(true),
      () => setPlaying(false),
    );
  }, []);

  const stop = useCallback(() => {
    const video = videoRef.current;
    setPlaying(false);
    if (!video) return;
    video.pause();
    video.currentTime = 0;
  }, []);

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

  return (
    <div
      ref={frameRef}
      className={`relative overflow-hidden ${className ?? ""}`}
      // The pointer is read off the frame, not the video: the video sits behind
      // `pointer-events: none` so it never swallows the click that opens the
      // photo full size.
      onPointerEnter={(e) => {
        if (motionUrl && e.pointerType === "mouse") start();
      }}
      onPointerLeave={(e) => {
        if (motionUrl && e.pointerType === "mouse") stop();
      }}
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
      {motionUrl && (
        <>
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
        </>
      )}
    </div>
  );
}
