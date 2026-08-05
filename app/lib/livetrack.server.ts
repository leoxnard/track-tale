import { decimate } from "./track";
import { parseLiveTrackHtml, type LiveSession } from "./livetrack";

/** Slow enough to be worth abandoning: the page still has to render without it. */
const TIMEOUT_MS = 5000;
/** A long ride's session would otherwise bloat every page load. */
const MAX_POINTS = 800;

/**
 * Fetch and parse a live session. Never throws: a live position is a bonus on
 * top of the trip page, and Garmin being slow, down, or having changed their
 * page must not take the whole page with it.
 */
export async function fetchLiveSession(liveUrl: string): Promise<LiveSession | null> {
  return (await probeLiveSession(liveUrl)).session;
}

/**
 * Why the live banner is doing what it is doing.
 *
 * Everything about this integration is other people's HTML, so when it stops
 * working there is nothing in the app to look at. `/live` reports this straight
 * back into the chat, which is the difference between "Garmin changed their
 * page again" and "the link never got stored in the first place".
 */
export type LiveProbe = {
  session: LiveSession | null;
  /** Short, human-readable account of the fetch — safe to show in Telegram. */
  detail: string;
  status: number | null;
};

export async function probeLiveSession(liveUrl: string): Promise<LiveProbe> {
  let url: URL;
  try {
    url = new URL(liveUrl);
  } catch {
    return { session: null, detail: "that is not a URL", status: null };
  }
  // The URL comes from an email or a chat message; only ever fetch Garmin.
  if (url.protocol !== "https:" || !/(^|\.)garmin\.com$/.test(url.hostname)) {
    return { session: null, detail: `refused to fetch ${url.hostname}`, status: null };
  }

  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        // Served the bare SPA shell without a browser-ish UA.
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        Accept: "text/html",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
  } catch (err) {
    const detail = err instanceof Error && err.name === "TimeoutError"
      ? `Garmin did not answer within ${TIMEOUT_MS / 1000}s`
      : `could not reach Garmin (${err instanceof Error ? err.message : "unknown error"})`;
    console.error("live session unavailable", err);
    return { session: null, detail, status: null };
  }

  if (!res.ok) {
    return { session: null, detail: `Garmin answered ${res.status}`, status: res.status };
  }

  let session: LiveSession | null;
  try {
    session = parseLiveTrackHtml(await res.text());
  } catch (err) {
    console.error("live session unavailable", err);
    return { session: null, detail: "the page could not be read", status: res.status };
  }
  if (!session) {
    // The one failure worth naming precisely: it means Garmin still served a
    // page, but not one with a session in it — an expired link, or a redesign.
    return {
      session: null,
      detail: "Garmin's page held no session data (link expired, or their page changed)",
      status: res.status,
    };
  }

  return {
    session: { ...session, points: decimate(session.points, MAX_POINTS) as LiveSession["points"] },
    detail: `${session.points.length} point(s) read`,
    status: res.status,
  };
}
