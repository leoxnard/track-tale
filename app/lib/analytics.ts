/**
 * Analytics — the one module that knows whether there are any.
 *
 * TrackTale counted visits with Vercel Analytics, which stopped counting the
 * moment the app stopped running on Vercel: the package ships a beacon that
 * posts to `/_vercel/insights`, a path that only exists because Vercel's edge
 * answers it. Off Vercel the script loads, the request 404s, and nothing says
 * so. It is replaced here by a self-hosted Umami, which is a plain script tag
 * pointed at a host we run.
 *
 * Everything is read from `import.meta.env`, so Vite bakes the values into the
 * bundle **at build time** — there is no runtime `process.env` on the client to
 * read them from later. Nothing is read through `env.server.ts`: that module is
 * server-only by design, and these three values have to survive into the
 * browser.
 *
 * With the vars unset nothing at all happens: no script tag, and `track()` is a
 * no-op. That is the normal state in development, which is why `.env` needs no
 * analytics entries to run the app locally, and why the preview page counts as
 * nothing.
 */

/** Full URL of the Umami loader, e.g. `https://analytics.example.de/script.js`. */
export const UMAMI_SRC = import.meta.env.VITE_UMAMI_SRC;

/** The website's UUID from Umami's settings. One per project — never shared. */
export const UMAMI_WEBSITE_ID = import.meta.env.VITE_UMAMI_WEBSITE_ID;

/**
 * Comma-separated host allow-list. Umami ignores hits from anywhere else, which
 * is what keeps a preview deployment or a `localhost` build with real vars set
 * out of the trip's numbers. Unset means "count every host this app is served
 * from".
 */
export const UMAMI_DOMAINS = import.meta.env.VITE_UMAMI_DOMAINS;

/** Both halves are needed; a src without an id measures nothing. */
export const isAnalyticsEnabled = Boolean(UMAMI_SRC && UMAMI_WEBSITE_ID);

type EventData = Record<string, string | number | boolean>;

declare global {
  interface Window {
    umami?: { track: (event: string, data?: EventData) => void };
  }
}

/**
 * Records a named event, if there is anything listening.
 *
 * Call sites need no guard of their own — before the script loads, on the
 * server, and on every build without the vars, this simply does nothing.
 *
 * Pageviews are *not* routed through here: Umami follows the History API by
 * itself, so a React Router navigation is already counted. Adding a navigation
 * effect on top would count every page twice.
 *
 * Nothing that identifies a traveller, a family member or a trip belongs in
 * `data` — a slug is the authorisation for a page, so it is a secret, not a
 * dimension to group by.
 */
export const track = (event: string, data?: EventData): void => {
  if (typeof window === "undefined" || !window.umami) return;
  try {
    window.umami.track(event, data);
  } catch {
    // Analytics must never break the page. A lost measurement is worth strictly
    // less than whatever the visitor was in the middle of doing.
  }
};
