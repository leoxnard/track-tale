import { Bot } from "grammy";
import { env } from "./env.server";
import { supabase } from "./supabase.server";
import { findLiveTrackUrl, isGarminSender } from "./live-link";
import { fetchLiveSession } from "./livetrack.server";
import { keepsStoredSession } from "./livetrack";
import { escapeMd } from "./telegram-md";

/**
 * Turning a Garmin LiveTrack email into the live banner on the trip page.
 *
 * Garmin mails a session link to its LiveTrack recipients when a ride starts;
 * pointing one of those recipients at the inbound address means the banner
 * comes on by itself. Pasting a link into the Telegram chat still works and is
 * handled separately in bot.server — this is the hands-off second route in.
 */

const LIVE_HOURS = 24;

export type InboundOutcome =
  | { ok: true; tripName: string; url: string }
  | { ok: false; reason: string };

/** The bits of Resend's `email.received` payload we rely on. */
interface ReceivedEvent {
  type?: string;
  data?: { email_id?: string; from?: string; subject?: string };
}

/**
 * Resend's webhook carries metadata only, so the body — where the link lives —
 * has to be fetched back with the email id.
 */
async function fetchBody(emailId: string): Promise<string> {
  const res = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
    headers: { Authorization: `Bearer ${env.resendApiKey}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`resend returned ${res.status} fetching email ${emailId}`);
  const mail = (await res.json()) as { text?: string | null; html?: string | null };
  // Prefer plain text; Garmin sends both and the text part has no markup to
  // trip the URL pattern up.
  return [mail.text, mail.html].filter(Boolean).join("\n");
}

/**
 * Which trip the link belongs to. The email says nothing about it, so it is the
 * owner's current trip: the one a chat has open, newest first, and failing that
 * the newest unfinished trip they own.
 */
interface TargetTrip {
  id: string;
  name: string;
  chat_id: number;
  live_url: string | null;
  live_expires_at: string | null;
}

async function resolveTrip(): Promise<TargetTrip | null> {
  const db = supabase();
  const { data: chats } = await db.from("chats").select("active_trip_id").not("active_trip_id", "is", null);
  const activeIds = (chats ?? []).map((c) => c.active_trip_id as string);

  const base = () =>
    db
      .from("trips")
      .select("id, name, chat_id, live_url, live_expires_at")
      .is("finished_at", null)
      .eq("owner_telegram_id", env.ownerTelegramId)
      .order("created_at", { ascending: false })
      .limit(1);

  if (activeIds.length > 0) {
    const { data } = await base().in("id", activeIds);
    if (data && data.length > 0) return data[0];
  }
  const { data } = await base();
  return data && data.length > 0 ? data[0] : null;
}

/**
 * Apply a verified inbound email. The signature is checked by the caller; this
 * decides whether the message deserves to change anything.
 */
export async function applyInboundLiveEmail(payload: unknown): Promise<InboundOutcome> {
  const event = payload as ReceivedEvent;
  if (event.type !== "email.received") return { ok: false, reason: `ignored event ${event.type}` };

  const from = event.data?.from ?? "";
  const emailId = event.data?.email_id;
  if (!emailId) return { ok: false, reason: "payload had no email id" };
  // Anyone can send mail to the inbound address, and this switches on a banner
  // the whole family sees, so only Garmin's own senders count.
  if (!isGarminSender(from)) return { ok: false, reason: `sender ${from} is not Garmin` };

  const url = findLiveTrackUrl(await fetchBody(emailId));
  if (!url) return { ok: false, reason: "no LiveTrack link in the email" };

  const trip = await resolveTrip();
  if (!trip) return { ok: false, reason: "no open trip to attach the link to" };

  if (await wouldDisplaceALiveSession(trip, url)) {
    return { ok: false, reason: "kept the session already recording; the new one is empty" };
  }

  const { error } = await supabase()
    .from("trips")
    .update({
      live_url: url,
      live_expires_at: new Date(Date.now() + LIVE_HOURS * 3600 * 1000).toISOString(),
    })
    .eq("id", trip.id);
  if (error) throw new Error(error.message);

  await notify(trip, url);
  return { ok: true, tripName: trip.name, url };
}

/**
 * Garmin sends an email per LiveTrack session, and opening a second session
 * does not close the first, so the newest link is not automatically the right
 * one. See {@link keepsStoredSession} for which one wins.
 */
async function wouldDisplaceALiveSession(trip: TargetTrip, incomingUrl: string): Promise<boolean> {
  const stored = trip.live_url;
  if (!stored || stored === incomingUrl) return false;
  if (!trip.live_expires_at || Date.parse(trip.live_expires_at) <= Date.now()) return false;

  const [incoming, current] = await Promise.all([
    fetchLiveSession(incomingUrl),
    fetchLiveSession(stored),
  ]);
  return keepsStoredSession(current, incoming);
}

/**
 * Say so in the chat. Something that turns itself on should never do it
 * silently — not least so a link on the wrong trip can be spotted.
 */
async function notify(trip: { name: string; chat_id: number }, url: string): Promise<void> {
  try {
    const bot = new Bot(env.telegramBotToken);
    await bot.api.sendMessage(
      trip.chat_id,
      `🔴 Garmin says you're rolling — live banner is on for ${LIVE_HOURS}h on *${escapeMd(trip.name)}*.\n` +
        `Family sees it at the top of the trip page.`,
      // Legacy Markdown, matching the rest of the bot: escapeMd escapes for
      // this parser, not for MarkdownV2's much longer list.
      { parse_mode: "Markdown", link_preview_options: { is_disabled: true } },
    );
  } catch (err) {
    // The banner is already live; failing to announce it is not worth undoing.
    console.error("could not announce the live link on Telegram", err, url);
  }
}
