/**
 * Umami, self-hosted on analytics.leonardsima.de. The instance runs on the same
 * machine as the app, so nothing leaves our own infrastructure.
 *
 * The website id and host sit here rather than in an env var: the id is visible
 * in the served HTML anyway, and this way a deploy needs no configuration.
 * `UMAMI_DOMAINS` keeps a local dev server or a preview out of the stats.
 *
 * RULE — never put personal data in an event. No traveler names, no trip
 * slugs, no coordinates. Counters and coarse categories only.
 */

export const UMAMI_SRC = "https://analytics.leonardsima.de/script.js";
export const UMAMI_WEBSITE_ID = "e12c284a-6393-406d-86ed-4045862f7255";
export const UMAMI_DOMAINS = "track-tale.leonardsima.de";

/**
 * Replaces a trip or traveler slug in the reported URL with a placeholder.
 *
 * A trip is shared as a secret no-login link: the slug in the path IS the
 * credential. Anything that logs the full URL hands out access, so the slug is
 * stripped before a page view is sent — even to our own analytics server. We
 * still learn that a trip page was opened, just not which trip.
 */
export function scrubUrl(url: string): string {
  return url.replace(/^\/(t|traveler)\/[^/?#]+/, "/$1/[slug]");
}

type EventData = Record<string, string | number | boolean>;

type UmamiPayload = { url: string; referrer: string; [key: string]: unknown };

declare global {
  interface Window {
    umami?: {
      track: {
        (event: string, data?: EventData): void;
        (payload: (props: UmamiPayload) => UmamiPayload): void;
      };
    };
  }
}

/**
 * Runs `fn` once the tracker has loaded. If the script is still in flight we
 * wait for its `load` event; if it is missing entirely (blocker, local dev),
 * nothing happens.
 */
function withUmami(fn: (umami: NonNullable<Window["umami"]>) => void): void {
  if (typeof window === "undefined") return;
  if (window.umami) {
    fn(window.umami);
    return;
  }
  const script = document.querySelector<HTMLScriptElement>(
    `script[data-website-id="${UMAMI_WEBSITE_ID}"]`,
  );
  if (!script) return;
  script.addEventListener(
    "load",
    () => {
      if (window.umami) fn(window.umami);
    },
    { once: true },
  );
}

/** Reports a page view with the scrubbed URL. */
export function trackPageView(url: string): void {
  const clean = scrubUrl(url);
  withUmami((umami) => {
    try {
      umami.track((props) => ({ ...props, url: clean }));
    } catch {
      // A failed measurement is worth less than the action in progress.
    }
  });
}

/** Reports a named event. A no-op without the tracker. */
export function track(event: string, data?: EventData): void {
  withUmami((umami) => {
    try {
      umami.track(event, data);
    } catch {
      // As above.
    }
  });
}
