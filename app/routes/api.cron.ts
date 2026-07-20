import { Bot } from "grammy";
import { env } from "../lib/env.server";
import { supabase } from "../lib/supabase.server";
import { refreshPlan } from "../lib/bot.server";

/**
 * Daily maintenance, triggered by Vercel Cron (schedule in vercel.json).
 * 1. Reminder: if the previous trip-local day has no track, silently ping the owner.
 * 2. Re-fetch Komoot-linked plan segments so edits propagate.
 * 3. Expire stale live links.
 */
export async function loader({ request }: { request: Request }) {
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${env.cronSecret}`) {
    return new Response("forbidden", { status: 403 });
  }

  const bot = new Bot(env.telegramBotToken);
  const today = new Date().toISOString().slice(0, 10);
  const report: string[] = [];

  const { data: trips } = await supabase()
    .from("trips")
    .select("*")
    .lte("start_date", today)
    .gte("end_date", addDays(today, -1)); // include trips that ended yesterday

  for (const trip of trips ?? []) {
    // Previous local day in the trip's timezone.
    const localToday = new Date().toLocaleDateString("en-CA", { timeZone: trip.timezone });
    const yesterday = addDays(localToday, -1);
    if (yesterday >= trip.start_date && yesterday <= trip.end_date) {
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
        try {
          // Reminders go to the chat that owns the trip, so a travelling group
          // sees them together rather than only the person who created it.
          await bot.api.sendMessage(
            trip.chat_id,
            `🌙 Reminder: no track saved for ${yesterday} (day ${dayNumber}) of "${trip.name}" yet.\n` +
              `Send /day ${dayNumber} and then the Komoot link or GPX file when you get a chance.`,
            { disable_notification: true },
          );
          report.push(`reminded ${trip.name}`);
        } catch (err) {
          report.push(`reminder failed for ${trip.name}: ${err}`);
        }
      }
    }

    const refreshed = await refreshPlan(trip.id);
    if (refreshed > 0) report.push(`refreshed ${refreshed} plan segments for ${trip.name}`);
  }

  const { data: expired } = await supabase()
    .from("trips")
    .update({ live_url: null, live_expires_at: null })
    .not("live_url", "is", null)
    .lt("live_expires_at", new Date().toISOString())
    .select("id");
  if ((expired ?? []).length > 0) report.push(`expired ${expired!.length} live links`);

  return Response.json({ ok: true, report });
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
