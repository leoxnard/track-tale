import { Bot } from "grammy";
import { env } from "../lib/env.server";
import { supabase } from "../lib/supabase.server";
import { backfillRideOriginals, refreshPlan } from "../lib/bot-ingest.server";
import { ensureTapsDelivered } from "../lib/bot-chrome.server";
import { sweepParkedMotions } from "../lib/bot-motion.server";

/**
 * Daily maintenance, triggered once a day by whatever schedules the deploy:
 * Vercel Cron (schedule in vercel.json), or any cron that can send the Bearer
 * token when the app is self-hosted.
 * 1. Reminder: if the previous trip-local day has no track, silently ping the owner.
 * 2. Re-fetch Komoot-linked plan segments so edits propagate, and fill in the
 *    kept recording for Komoot days imported before those were kept.
 * 3. Expire stale live links.
 *
 * Nobody reads the response body, so anything that goes wrong is both logged and
 * pushed to the owner on Telegram — a job that quietly stops reminding is worse
 * than one that fails loudly. Each step is isolated so one bad trip cannot stop
 * the rest of the run.
 */
export async function loader({ request }: { request: Request }) {
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${env.cronSecret}`) {
    return new Response("forbidden", { status: 403 });
  }

  const bot = new Bot(env.telegramBotToken);
  const today = new Date().toISOString().slice(0, 10);
  const report: string[] = [];
  const failures: string[] = [];

  const { data: trips, error } = await supabase()
    .from("trips")
    .select("*")
    .is("finished_at", null) // a finished trip is done being maintained
    .lte("start_date", today)
    // Include trips that ended yesterday, and trips with no end date yet —
    // a null end_date fails .gte() outright, so it needs its own clause.
    .or(`end_date.is.null,end_date.gte.${addDays(today, -1)}`);
  if (error) failures.push(`could not load trips: ${error.message}`);

  for (const trip of trips ?? []) {
    try {
      // Previous local day in the trip's timezone.
      const localToday = new Date().toLocaleDateString("en-CA", { timeZone: trip.timezone });
      const yesterday = addDays(localToday, -1);
      if (
        trip.reminders_enabled &&
        yesterday >= trip.start_date &&
        (trip.end_date === null || yesterday <= trip.end_date)
      ) {
        const { data: day } = await supabase()
          .from("days")
          .select("id, day_number, track_segments(id)")
          .eq("trip_id", trip.id)
          .eq("date", yesterday)
          .maybeSingle();
        const hasTrack =
          day && (day as { track_segments: { id: string }[] }).track_segments.length > 0;
        if (!hasTrack) {
          const dayNumber =
            Math.round((Date.parse(yesterday) - Date.parse(trip.start_date)) / 86400000) + 1;
          // Reminders go to the chat that owns the trip, so a travelling group
          // sees them together rather than only the person who created it.
          await bot.api.sendMessage(
            trip.chat_id,
            `🌙 Reminder: no track saved for ${yesterday} (day ${dayNumber}) of "${trip.name}" yet.\n` +
              `Send /day ${dayNumber} and then the Komoot link or GPX file when you get a chance.\n` +
              `(/reminders off to stop these, /endtrip if the journey is over.)`,
            { disable_notification: true },
          );
          report.push(`reminded ${trip.name}`);
        }
      }

      const refreshed = await refreshPlan(trip.id);
      if (refreshed > 0) report.push(`refreshed ${refreshed} plan segments for ${trip.name}`);

      // Empties itself out: once a day has its recording kept, it is no longer
      // selected, so this costs one query a night for a trip that is done.
      const { stored } = await backfillRideOriginals(trip.id);
      if (stored > 0) report.push(`kept ${stored} recorded days for ${trip.name}`);
    } catch (err) {
      failures.push(`${trip.name}: ${message(err)}`);
    }
  }

  try {
    // Belt to the webhook handler's braces: that one only runs when an update
    // arrives, and a chat whose buttons all hang is a chat nobody is sending
    // updates from.
    if ((await ensureTapsDelivered(bot)) === "repaired") {
      report.push("re-subscribed the webhook to button taps");
    }
  } catch (err) {
    failures.push(`checking what Telegram delivers: ${message(err)}`);
  }

  try {
    const swept = await sweepParkedMotions();
    if (swept > 0) report.push(`swept ${swept} unclaimed Live Photo videos`);
  } catch (err) {
    failures.push(`sweeping unclaimed Live Photo videos: ${message(err)}`);
  }

  try {
    const { data: expired, error: expireError } = await supabase()
      .from("trips")
      .update({ live_url: null, live_expires_at: null })
      .not("live_url", "is", null)
      .lt("live_expires_at", new Date().toISOString())
      .select("id");
    if (expireError) throw new Error(expireError.message);
    if ((expired ?? []).length > 0) report.push(`expired ${expired!.length} live links`);
  } catch (err) {
    failures.push(`expiring live links: ${message(err)}`);
  }

  if (failures.length > 0) {
    console.error("cron finished with failures", failures);
    await alertOwner(bot, failures);
  }

  return Response.json({ ok: failures.length === 0, report, failures });
}

/**
 * Last resort: if even this fails there is nowhere left to report to, so the
 * log line is all we have.
 */
async function alertOwner(bot: Bot, failures: string[]): Promise<void> {
  try {
    // Plain text on purpose — error messages carry arbitrary characters and
    // would break a Markdown-parsed message.
    await bot.api.sendMessage(
      env.ownerTelegramId,
      `⚠️ TrackTale nightly job had ${failures.length} problem(s):\n` +
        failures.map((f) => `• ${f}`).join("\n"),
      { disable_notification: true },
    );
  } catch (err) {
    console.error("cron could not reach the owner about its failures", err);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
