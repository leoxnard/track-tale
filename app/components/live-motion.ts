import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Playing the three seconds behind a Live Photo, and the finger gestures that
 * ask for them.
 *
 * Shared by the grid tile and the full-screen viewer because the fiddly parts
 * are the same in both, and both got them wrong independently:
 *
 * - **`pointerleave` fires after a touch ends.** On iOS, lifting a finger emits
 *   `pointerout`/`pointerleave` on the way out, so treating that as "the
 *   pointer went away, stop the video" meant a tap started the video and
 *   stopped it in the same breath. Leaving is only a stop for a mouse, which is
 *   the only pointer that can be somewhere without touching anything.
 * - **A hold starts the video; letting go does not stop it.** See `onPointerUp`.
 * - **A long press is a link's enemy.** The tile is a real anchor, so the press
 *   that plays the video is followed by a click that would open the photo full
 *   screen — and, before that, by iOS's own press-and-hold callout offering to
 *   open the link in a new tab. Both have to be turned off for the gesture to
 *   feel like the one people know from a phone, and only for tiles that
 *   actually have motion: a plain photo keeps its ordinary long-press menu.
 * - **Rewinding is visible unless it is hidden on purpose.** See `start`/`stop`;
 *   between them they cost two rounds of flicker to get right.
 */

/** How long a finger has to stay put before it counts as a hold and not a tap. */
const HOLD_MS = 250;

/** Past this a press is a scroll that started on a photo, not a hold. */
const HOLD_SLOP_PX = 12;

/**
 * How long the still takes to fade back over the video. Must not be shorter
 * than the CSS transition on the two elements — it is the window during which
 * the video is still partly on screen and must therefore not move.
 */
const FADE_MS = 260;

interface Options {
  /**
   * Whether a mouse can hold to play too. False where the press has to leave
   * room for an ordinary click — in the grid a slow click still has to open the
   * photo, and hovering already plays it there.
   */
  holdWithMouse?: boolean;
  /** Whether a short tap plays it through, rather than only a hold. */
  playOnTap?: boolean;
}

export function useLiveMotion({ holdWithMouse = false, playOnTap = false }: Options = {}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);

  const hold = useRef<number | null>(null);
  const rewind = useRef<number | null>(null);
  const from = useRef<{ x: number; y: number } | null>(null);
  const held = useRef(false);
  /** Set by a hold, read and cleared by the click that follows it. */
  const swallowClick = useRef(false);

  /**
   * Show the video only once a frame from its new position has actually been
   * painted. Without this the element turns opaque the moment `play()` resolves
   * — while it is still holding whatever frame it stopped on last time — so a
   * replay read as: old last frame, first frame, motion.
   */
  const revealOnFirstFrame = (video: HTMLVideoElement) => {
    if (typeof video.requestVideoFrameCallback === "function") {
      video.requestVideoFrameCallback(() => setPlaying(true));
    } else {
      setPlaying(true);
    }
  };

  const start = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (rewind.current !== null) {
      window.clearTimeout(rewind.current);
      rewind.current = null;
    }

    const play = () =>
      void video.play().then(
        () => revealOnFirstFrame(video),
        // Autoplay is refused often enough — a muted inline video is normally
        // allowed, but not always — and a rejected promise here is not an error
        // worth anyone's console: the still is a perfectly good photograph.
        () => setPlaying(false),
      );

    // Usually already rewound by `stop`, once it was safe to. Not always: a
    // replay asked for during the fade-out arrives before that, and then the
    // seek has to happen here — before playing, and before anything is shown.
    if (video.currentTime > 0 && video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      video.addEventListener("seeked", play, { once: true });
      video.currentTime = 0;
      return;
    }
    play();
  }, []);

  const stop = useCallback(() => {
    const video = videoRef.current;
    setPlaying(false);
    if (!video) return;
    video.pause();

    // Rewound on a delay rather than here, because here the video is still on
    // screen: it is fading out under the still, and jumping it back to frame
    // one mid-fade put the beginning of the clip on screen just as the clip
    // ended. Wait for the fade, then rewind where nobody can see it.
    if (rewind.current !== null) window.clearTimeout(rewind.current);
    rewind.current = window.setTimeout(() => {
      rewind.current = null;
      if (videoRef.current) videoRef.current.currentTime = 0;
    }, FADE_MS);
  }, []);

  const clearHold = () => {
    if (hold.current !== null) window.clearTimeout(hold.current);
    hold.current = null;
  };

  useEffect(
    () => () => {
      if (hold.current !== null) window.clearTimeout(hold.current);
      if (rewind.current !== null) window.clearTimeout(rewind.current);
    },
    [],
  );

  const press = {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType === "mouse" && !holdWithMouse) return;
      from.current = { x: e.clientX, y: e.clientY };
      held.current = false;
      clearHold();
      hold.current = window.setTimeout(() => {
        held.current = true;
        start();
      }, HOLD_MS);
    },
    onPointerMove: (e: React.PointerEvent) => {
      // A finger that has travelled is scrolling the page. Let it, and don't
      // start a video underneath it.
      const origin = from.current;
      if (!origin || held.current) return;
      if (Math.hypot(e.clientX - origin.x, e.clientY - origin.y) > HOLD_SLOP_PX) clearHold();
    },
    onPointerUp: () => {
      clearHold();
      if (held.current) {
        held.current = false;
        // The click this press is about to produce belongs to the hold, not to
        // whatever the tile links to.
        swallowClick.current = true;
        // Deliberately not stopped. Cutting the video off at the moment the
        // finger lifts is what an iPhone does, but an iPhone is answering a
        // press that began the instant you touched the screen; here a quarter
        // of a second has already gone on deciding this was a hold at all, so
        // letting go a moment later would show almost nothing and read as the
        // gesture having failed. Three seconds is short enough to simply run.
        return;
      }
      if (playOnTap) start();
    },
    onPointerCancel: () => {
      clearHold();
      if (held.current) {
        held.current = false;
        stop();
      }
    },
    onPointerLeave: (e: React.PointerEvent) => {
      clearHold();
      // See the note at the top: for a finger this fires on the way out of an
      // ordinary tap, and stopping here would undo the tap that just started it.
      if (e.pointerType === "mouse") stop();
    },
    // iOS offers to open the link when a press lasts; that offer is exactly
    // what this gesture is instead of.
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    onClick: (e: React.MouseEvent) => {
      if (!swallowClick.current) return;
      swallowClick.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
  };

  return { videoRef, playing, start, stop, press };
}
