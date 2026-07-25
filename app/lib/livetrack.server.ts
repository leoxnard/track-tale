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
  let url: URL;
  try {
    url = new URL(liveUrl);
  } catch {
    return null;
  }
  // The URL comes from an email or a chat message; only ever fetch Garmin.
  if (url.protocol !== "https:" || !/(^|\.)garmin\.com$/.test(url.hostname)) return null;

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        // Served the bare SPA shell without a browser-ish UA.
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        Accept: "text/html",
      },
    });
    if (!res.ok) return null;

    const session = parseLiveTrackHtml(await res.text());
    if (!session) return null;

    return { ...session, points: decimate(session.points, MAX_POINTS) as LiveSession["points"] };
  } catch (err) {
    console.error("live session unavailable", err);
    return null;
  }
}
