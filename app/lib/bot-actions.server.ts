import { InlineKeyboard, InputFile, type Context } from "grammy";
import { env } from "./env.server";
import { supabase } from "./supabase.server";
import {
  deleteTrip,
  ensureDay,
  listTrips,
  reopenTrip,
  setActiveTrip,
  updateTrip,
  type DbChat,
  type DbTrip,
} from "./db.server";
import { computeStats, type TrackPoint } from "./track";
import { toGpx } from "./gpx-export";
import { renderOgCard } from "./og.server";
import { escapeMd, slugId } from "./telegram-md";
import { encodeAction } from "./manage";
import { clearDay, dayTally, tallyTotal, type View } from "./manage.server";
import {
  backToStatus,
  dayNavKeyboard,
  dayPickerView,
  describeTally,
  myPageConfirmView,
  tripPickerView,
  tripStatusView,
} from "./screens.server";
import { sendView } from "./bot-chrome.server";

/**
 * The things a trip has done to it — switching, emptying a day, merging
 * uploads, deleting it — each one written once and reached from both a command
 * and a button, so the two can never drift apart.
 */

export function remindersMessage(on: boolean): string {
  return on
    ? "🔔 Reminders on — I'll ping this chat quietly when a day has no track."
    : "🔕 Reminders off for this trip. Everything else works as before.";
}

/** tripDayCount is Infinity for a trip with no end date yet — /day is unbounded until /endtrip. */
export function dayRange(max: number): string {
  return Number.isFinite(max) ? `1–${max}` : "1 or more";
}

/**
 * Make this trip the one uploads land on. Picking a finished trip is how you
 * reopen one that ended too early, so that is what tapping it does.
 */
export async function activateTrip(chatId: number, trip: DbTrip): Promise<DbTrip> {
  if (trip.finished_at) {
    await reopenTrip(trip);
    return { ...trip, finished_at: null };
  }
  await setActiveTrip(chatId, trip.id);
  return trip;
}

/** Switch, then show where that trip stands — the screen you wanted anyway. */
export async function tripSwitchedView(chatId: number, trip: DbTrip): Promise<View> {
  const wasFinished = trip.finished_at !== null;
  const active = await activateTrip(chatId, trip);
  const view = await tripStatusView(active);
  return {
    ...view,
    text:
      `✅ Active trip: *${escapeMd(active.name)}*${wasFinished ? " — reopened, so uploads land here again" : ""}\n\n` +
      view.text,
  };
}

export async function switchToTrip(ctx: Context, trip: DbTrip) {
  await sendView(ctx, await tripSwitchedView(ctx.state.chat.chat_id, trip));
}

/**
 * Empty a day and say what went, from either the command or the button.
 *
 * The tally is taken before the deletion, because afterwards there is nothing
 * left to count — and "day 3 is empty" without saying what it held is not a
 * confirmation anyone can check.
 */
export async function runClearDay(trip: DbTrip, n: number): Promise<View> {
  const tally = await dayTally(trip, n);
  if (!tally || tallyTotal(tally) === 0) {
    return { text: `Day ${n} has nothing on it.`, keyboard: backToStatus() };
  }
  const what = describeTally(tally);

  try {
    await clearDay(trip, n);
  } catch (err) {
    return {
      text: `⚠️ Clearing day ${n} failed: ${err instanceof Error ? err.message : "unknown error"}. Nothing was removed.`,
      keyboard: backToStatus(),
    };
  }

  // The day's distance was part of what the share card showed.
  await renderOgCard(trip.id).catch(() => {});

  const view = await dayPickerView(trip, 0, "clear");
  return { ...view, text: `🗑️ Day ${n} is empty — ${what} removed.\n\n${view.text}` };
}

/**
 * The two ways out of a GPX merge session, offered on every message that is
 * part of one — so "what do I send now?" never needs answering from memory.
 */
export function mergeSessionKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Finish & merge", encodeAction({ type: "mergefinish" }))
    .text("✖️ Cancel", encodeAction({ type: "mergecancel" }));
}

/** Stitch the session's uploads into one GPX and send it back as a file. */
export async function finishGpxMerge(ctx: Context) {
  const chatId = ctx.chat!.id;
  const { data: session } = await supabase()
    .from("gpx_merge_sessions")
    .select("name, tracks")
    .eq("chat_id", chatId)
    .maybeSingle();

  if (!session) {
    await ctx.reply('No GPX merge session open here. Start one with /mergegpx "Tour Name".');
    return;
  }

  const tracks = (session.tracks ?? []) as { points?: TrackPoint[]; sport?: string }[];
  if (tracks.length < 2) {
    await ctx.reply("Need at least 2 GPX files in session. Upload more first.", {
      reply_markup: mergeSessionKeyboard(),
    });
    return;
  }

  const allPoints: TrackPoint[] = [];
  for (const t of tracks) allPoints.push(...(t.points ?? []));

  const hasTime = allPoints.every((p) => p.time !== undefined);
  if (hasTime) allPoints.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));

  computeStats(allPoints);
  const gpx = toGpx(session.name, [allPoints]);

  await supabase().from("gpx_merge_sessions").delete().eq("chat_id", chatId);

  await ctx.replyWithDocument(
    new InputFile(Buffer.from(gpx), `${session.name.replace(/[^a-z0-9_-]/gi, "_")}.gpx`),
    {
      caption: `✅ Merged ${tracks.length} GPX file(s) into ${session.name} (${(gpx.length / 1024).toFixed(1)} KB)`,
    },
  );
}

export async function cancelGpxMerge(ctx: Context) {
  const { data: removed } = await supabase()
    .from("gpx_merge_sessions")
    .delete()
    .eq("chat_id", ctx.chat!.id)
    .select("name");
  await ctx.reply(
    removed && removed.length > 0
      ? `✖️ Merge session dropped. The uploaded files stay where they were.`
      : "No GPX merge session open here.",
  );
}

/** Erase a trip, then come back with what is left in the chat. */
export async function runDeleteTrip(chat: DbChat, trip: DbTrip): Promise<View> {
  try {
    await deleteTrip(trip);
  } catch (err) {
    return {
      text: `⚠️ Delete failed: ${err instanceof Error ? err.message : "unknown error"}. Nothing was removed.`,
      keyboard: new InlineKeyboard().text("🎒 Trips", encodeAction({ type: "trips" })),
    };
  }

  const trips = await listTrips(chat.chat_id);
  const active = chat.active_trip_id === trip.id ? null : chat.active_trip_id;
  const view = tripPickerView(trips, active, "use");
  return { ...view, text: `🗑️ ${trip.name} is gone, photos and all.\n\n${view.text}` };
}

/** The traveller page link, and the one tap that replaces it. */
export async function myPageLinkView(ctx: Context, confirmed: boolean): Promise<View> {
  const { senderId, isRegistered } = ctx.state;
  if (!isRegistered) {
    return { text: "Only invited travellers have a page.", keyboard: new InlineKeyboard() };
  }
  if (!confirmed) return myPageConfirmView();

  const slug = slugId(20);
  await supabase().from("users").update({ traveler_slug: slug }).eq("telegram_id", senderId);
  return {
    text: `🔗 Old page link is dead. New one:\n${env.appOrigin}/traveler/${slug}`,
    keyboard: new InlineKeyboard(),
  };
}

/**
 * Shared body of /day <n>, /dayN, /nextday, /previousday: n is assumed to
 * already be a valid integer within [1, max] — callers handle their own
 * usage/boundary messaging before reaching here. The neighbours ride along on
 * the confirmation, so the next day is a tap rather than another command.
 */
export async function setCurrentDay(ctx: Context, trip: DbTrip, n: number) {
  const day = await ensureDay(trip, n);
  await updateTrip(trip.id, { current_day_number: n });
  await ctx.reply(`📅 Day ${n} (${day.date}) is now current — uploads land here.`, {
    reply_markup: dayNavKeyboard(trip, n),
  });
}
