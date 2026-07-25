/**
 * Recognising Garmin LiveTrack links, shared by the two ways one can arrive:
 * pasted into the Telegram chat, or emailed by Garmin when a ride starts.
 */

/**
 * Stops at quotes, angle brackets and parens as well as whitespace, because the
 * same pattern has to survive being run over an HTML email body where the link
 * sits inside href="...".
 *
 * The `(?![\w.-])` after the host is load-bearing: without it the pattern also
 * matches `livetrack.garmin.com.evil.example`, and this link is shown to the
 * family as the place to follow along.
 */
export const LIVETRACK_RE =
  /https?:\/\/(?:livetrack\.garmin\.com|[a-z]+\.garmin\.com\/livetrack)(?![\w.-])[^\s"'<>)\]]*/i;

/** First LiveTrack URL in a blob of plain text or HTML, if there is one. */
export function findLiveTrackUrl(text: string): string | null {
  const match = text.match(LIVETRACK_RE);
  if (!match) return null;
  // An HTML body carries entity-escaped query separators.
  return match[0].replace(/&amp;/g, "&").replace(/[.,;]+$/, "");
}

/**
 * True only for mail genuinely from Garmin. `from` may be a bare address or a
 * display-name form, so the address is pulled out of the angle brackets first.
 */
export function isGarminSender(from: string): boolean {
  const angled = from.match(/<([^>]+)>/);
  const address = (angled ? angled[1] : from).trim().toLowerCase();
  const at = address.lastIndexOf("@");
  if (at === -1) return false;
  const domain = address.slice(at + 1);
  return domain === "garmin.com" || domain.endsWith(".garmin.com");
}
