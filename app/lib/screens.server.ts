import { InlineKeyboard } from "grammy";
import { supabase } from "./supabase.server";
import { env } from "./env.server";
import { escapeMd } from "./telegram-md";
import { countSummary, encodeAction, type DayPickerMode } from "./manage";
import { dayTally, loadDays, tallyTotal, type DayTally, type View } from "./manage.server";
import { tripDayCount, type DbTrip } from "./db.server";

/**
 * The screens that turn a command you have to remember the syntax of into a
 * keyboard you can tap.
 *
 * `/manage` proved the pattern: one message, edited in place, that carries its
 * own next steps. Everything here follows it, so switching day, switching trip,
 * ending a trip or emptying a day is a tap from wherever you already are —
 * rather than a reply explaining what you should have typed.
 */

/** Days on one page of the picker, and how many share a row. */
export const DAYS_PER_PAGE = 30;
const DAY_COLUMNS = 3;
/** Rows on one page of the clear picker, which lists a day per row. */
const CLEAR_PER_PAGE = 12;

/** Which page of the day picker a given day sits on. */
export function pageOfDay(dayNumber: number): number {
  return Math.max(0, Math.floor((dayNumber - 1) / DAYS_PER_PAGE));
}

export function tripLink(trip: DbTrip): string {
  return `${env.appOrigin}/t/${trip.share_slug}`;
}

export function km(m: number): string {
  return (m / 1000).toFixed(1);
}

export interface TripTotals {
  distanceM: number;
  elevationUp: number;
  daysWithTracks: number;
  planM: number;
}

export async function tripTotals(tripId: string): Promise<TripTotals> {
  const { data: days } = await supabase()
    .from("days")
    .select("id, day_number, track_segments(distance_m, elevation_up)")
    .eq("trip_id", tripId);

  const totals: TripTotals = { distanceM: 0, elevationUp: 0, daysWithTracks: 0, planM: 0 };
  for (const d of days ?? []) {
    const segs = (d as { track_segments: { distance_m: number; elevation_up: number }[] })
      .track_segments;
    if (segs.length > 0) totals.daysWithTracks++;
    for (const s of segs) {
      totals.distanceM += s.distance_m;
      totals.elevationUp += s.elevation_up;
    }
  }

  const { data: plans } = await supabase()
    .from("plan_segments")
    .select("distance_m")
    .eq("trip_id", tripId);
  totals.planM = (plans ?? []).reduce((sum, p) => sum + p.distance_m, 0);
  return totals;
}

/**
 * How many days the picker offers.
 *
 * A trip with an end date has a known length. One without runs until /endtrip,
 * so there is no last day to show — the picker offers everything that exists
 * plus one more, which is exactly the day you are about to start.
 */
function pickerLength(trip: DbTrip, highestUsed: number): number {
  const max = tripDayCount(trip);
  if (Number.isFinite(max)) return Math.max(1, max);
  return Math.max(1, Math.max(highestUsed, trip.current_day_number ?? 0) + 1);
}

function pagingRow(
  keyboard: InlineKeyboard,
  page: number,
  pageCount: number,
  mode: DayPickerMode,
) {
  if (pageCount <= 1) return;
  if (page > 0) {
    keyboard.text("‹ Previous", encodeAction({ type: "days", page: page - 1, mode }));
  }
  if (page < pageCount - 1) {
    keyboard.text("Next ›", encodeAction({ type: "days", page: page + 1, mode }));
  }
  keyboard.row();
}

/**
 * Pick a day: the answer to "/day 3" being a thing you had to know to type.
 *
 * In "set" mode every day of the trip is a button, the current one marked and
 * the ones that already hold something dotted, so the choice is made against
 * what the trip actually looks like. In "clear" mode only days with something
 * on them appear — emptying an empty day is not a thing anyone means to do.
 */
export async function dayPickerView(
  trip: DbTrip,
  page: number,
  mode: DayPickerMode,
): Promise<View> {
  const days = await loadDays(trip.id);
  const filled = new Map(days.map((d) => [d.day_number, d]));
  const keyboard = new InlineKeyboard();

  if (mode === "clear") {
    if (days.length === 0) {
      keyboard.text("🎒 Trip", encodeAction({ type: "status" }));
      return {
        text: `*${escapeMd(trip.name)}* has no day with anything on it yet.`,
        keyboard,
        markdown: true,
      };
    }

    const pageCount = Math.max(1, Math.ceil(days.length / CLEAR_PER_PAGE));
    const current = Math.min(Math.max(page, 0), pageCount - 1);
    for (const day of days.slice(current * CLEAR_PER_PAGE, current * CLEAR_PER_PAGE + CLEAR_PER_PAGE)) {
      const counts = {
        note: day.notes.length,
        media: day.media.length,
        track_segment: day.track_segments.length,
        comment: day.comments.length,
      };
      keyboard
        .text(
          `🗑 Day ${day.day_number} · ${countSummary(counts)}`,
          encodeAction({ type: "clearday", dayNumber: day.day_number, confirmed: false }),
        )
        .row();
    }
    pagingRow(keyboard, current, pageCount, "clear");
    keyboard.text("🗂️ Manage", encodeAction({ type: "home" }));
    keyboard.text("🎒 Trip", encodeAction({ type: "status" }));

    return {
      text:
        `🗑️ *${escapeMd(trip.name)}* — pick the day to empty.\n\n` +
        `_Every note, photo and track on it goes for good. Guestbook messages stay._`,
      keyboard,
      markdown: true,
    };
  }

  const highestUsed = days.reduce((max, d) => Math.max(max, d.day_number), 0);
  const length = pickerLength(trip, highestUsed);
  const pageCount = Math.max(1, Math.ceil(length / DAYS_PER_PAGE));
  const current = Math.min(Math.max(page, 0), pageCount - 1);
  const first = current * DAYS_PER_PAGE + 1;
  const last = Math.min(length, first + DAYS_PER_PAGE - 1);

  let inRow = 0;
  for (let n = first; n <= last; n++) {
    const mark = n === trip.current_day_number ? "✅ " : filled.has(n) ? "• " : "";
    keyboard.text(`${mark}Day ${n}`, encodeAction({ type: "setday", dayNumber: n }));
    if (++inRow % DAY_COLUMNS === 0) keyboard.row();
  }
  if (inRow % DAY_COLUMNS !== 0) keyboard.row();

  pagingRow(keyboard, current, pageCount, "set");
  keyboard.text("🗂️ Manage", encodeAction({ type: "home" }));
  keyboard.text("🎒 Trip", encodeAction({ type: "status" }));

  const currentDay = trip.current_day_number ? filled.get(trip.current_day_number) : undefined;
  const paging = pageCount > 1 ? ` — page ${current + 1}/${pageCount}` : "";
  return {
    text:
      `📅 *${escapeMd(trip.name)}* — pick the day uploads land on${paging}.\n\n` +
      (trip.current_day_number
        ? `Now on *day ${trip.current_day_number}*${currentDay ? ` (${currentDay.date})` : ""}.\n`
        : `No day set yet — nothing can be uploaded until one is.\n`) +
      `_✅ current · • already has something on it_`,
    keyboard,
    markdown: true,
  };
}

/** The nav that follows a day change: neighbours either side, and the picker. */
export function dayNavKeyboard(trip: DbTrip, dayNumber: number): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (dayNumber > 1) {
    keyboard.text(`‹ Day ${dayNumber - 1}`, encodeAction({ type: "setday", dayNumber: dayNumber - 1 }));
  }
  keyboard.text("📅 All days", encodeAction({ type: "days", page: pageOfDay(dayNumber), mode: "set" }));
  if (dayNumber < tripDayCount(trip)) {
    keyboard.text(`Day ${dayNumber + 1} ›`, encodeAction({ type: "setday", dayNumber: dayNumber + 1 }));
  }
  return keyboard;
}

/**
 * Every trip in this chat, as buttons.
 *
 * "use" switches the active one — including reopening a finished trip, which is
 * what tapping one that has already ended means. "delete" leads to the
 * confirmation instead, so the same list serves /trips and /deletetrip.
 */
export function tripPickerView(
  trips: DbTrip[],
  activeTripId: string | null,
  mode: "use" | "delete",
): View {
  const keyboard = new InlineKeyboard();
  if (trips.length === 0) {
    return {
      text: "No trips in this chat yet.\n\n/newtrip Name | 2026-08-01",
      keyboard,
    };
  }

  for (const trip of trips) {
    const mark = trip.id === activeTripId ? "✅ " : trip.finished_at ? "🏁 " : "";
    keyboard
      .text(
        mode === "delete" ? `🗑 ${trip.name}` : `${mark}${trip.name}`,
        mode === "delete"
          ? encodeAction({ type: "deletetrip", id: trip.id, confirmed: false })
          : encodeAction({ type: "usetrip", id: trip.id }),
      )
      .row();
  }
  if (mode === "use") keyboard.text("🎒 Trip", encodeAction({ type: "status" }));

  const lines = trips.map((t) => {
    const mark = t.id === activeTripId ? " ✅ active" : t.finished_at ? " 🏁 finished" : "";
    return `• ${t.name} (${t.start_date} → ${t.end_date ?? "ongoing"})${mark}`;
  });

  return {
    text:
      mode === "delete"
        ? `🗑️ Which trip should go?\n\n${lines.join("\n")}\n\n` +
          `Deleting one takes its days, photos, notes and family page with it, for good.`
        : `🎒 Trips in this chat — tap one to make it active.\n\n${lines.join("\n")}\n\n` +
          `A finished trip reopens when you pick it.`,
    keyboard,
  };
}

/** The /trip screen: where the trip stands, and everything you can do to it. */
export async function tripStatusView(trip: DbTrip): Promise<View> {
  const totals = await tripTotals(trip.id);
  const progress =
    totals.planM > 0
      ? ` (${Math.min(100, Math.round((totals.distanceM / totals.planM) * 100))}% of plan)`
      : "";

  const liveMs = trip.live_expires_at ? Date.parse(trip.live_expires_at) : NaN;
  const liveOn = Boolean(trip.live_url) && Number.isFinite(liveMs) && liveMs > Date.now();

  const keyboard = new InlineKeyboard()
    .text("📅 Days", encodeAction({ type: "days", page: pageOfDay(trip.current_day_number ?? 1), mode: "set" }))
    .text("🗂️ Manage", encodeAction({ type: "home" }))
    .row()
    .text(
      trip.reminders_enabled ? "🔕 Reminders off" : "🔔 Reminders on",
      encodeAction({ type: "reminders", on: !trip.reminders_enabled }),
    )
    .text("🎒 Switch trip", encodeAction({ type: "trips" }))
    .row();
  if (liveOn) {
    keyboard.text("⚫️ Live banner off", encodeAction({ type: "liveoff" })).row();
  }
  keyboard
    .text("🔄 Swap a photo", encodeAction({ type: "replaceHome" }))
    .text("🗑️ Empty a day", encodeAction({ type: "days", page: 0, mode: "clear" }))
    .row()
    .text("🔗 New family link", encodeAction({ type: "relink", confirmed: false }))
    .text("🏁 End trip", encodeAction({ type: "endtrip", confirmed: false }));

  return {
    text:
      `🎒 *${escapeMd(trip.name)}* — ${trip.start_date} → ${trip.end_date ?? "ongoing"}\n` +
      `📅 Current day: ${trip.current_day_number ?? "not set"}\n` +
      `📏 ${km(totals.distanceM)} km over ${totals.daysWithTracks} tracked days${progress}\n` +
      `🔔 Reminders ${trip.reminders_enabled ? "on" : "off"}\n` +
      (liveOn ? `🔴 Live banner up\n` : "") +
      `👨‍👩‍👧 ${tripLink(trip)}`,
    keyboard,
    markdown: true,
  };
}

export function backToStatus(label = "🎒 Trip"): InlineKeyboard {
  return new InlineKeyboard().text(label, encodeAction({ type: "status" }));
}

/** "2 track(s), 5 photo(s)" — what emptying a day would actually take off it. */
export function describeTally(tally: DayTally): string {
  return [
    tally.tracks > 0 ? `${tally.tracks} track(s)` : null,
    tally.photos > 0 ? `${tally.photos} photo(s)` : null,
    tally.notes > 0 ? `${tally.notes} note(s)` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

/** The second tap before a whole day goes. */
export async function clearDayConfirmView(trip: DbTrip, dayNumber: number): Promise<View> {
  const tally = await dayTally(trip, dayNumber);
  if (!tally || tallyTotal(tally) === 0) {
    const keyboard = new InlineKeyboard()
      .text("🗑️ Another day", encodeAction({ type: "days", page: 0, mode: "clear" }))
      .text("🎒 Trip", encodeAction({ type: "status" }));
    return { text: `Day ${dayNumber} has nothing on it.`, keyboard };
  }

  return {
    text:
      `🗑️ Empty day ${dayNumber}?\n\nIt holds ${describeTally(tally)}. Clearing takes all of ` +
      `it off for good, photos and all.\n\n` +
      (tally.comments > 0
        ? `The ${tally.comments} guestbook message(s) stay — /manage removes those one at a time.`
        : ""),
    keyboard: new InlineKeyboard()
      .text(`🗑 Yes, empty day ${dayNumber}`, encodeAction({ type: "clearday", dayNumber, confirmed: true }))
      .row()
      .text("Cancel", encodeAction({ type: "days", page: 0, mode: "clear" })),
  };
}

export function endTripConfirmView(trip: DbTrip): View {
  return {
    text:
      `🏁 Finish *${escapeMd(trip.name)}*?\n\n` +
      `Nothing more lands here until you start or pick another trip. The family ` +
      `page, the photos and the link all keep working — and /trips picks this one ` +
      `back up if you end it early.`,
    keyboard: new InlineKeyboard()
      .text("🏁 Yes, finish it", encodeAction({ type: "endtrip", confirmed: true }))
      .row()
      .text("Cancel", encodeAction({ type: "status" })),
    markdown: true,
  };
}

/** What a finished trip leaves behind, and the way back to another one. */
export async function tripFinishedView(trip: DbTrip): Promise<View> {
  const totals = await tripTotals(trip.id);
  return {
    text:
      `🏁 *${escapeMd(trip.name)}* is finished — ${km(totals.distanceM)} km and ` +
      `${Math.round(totals.elevationUp)} m of climbing over ${totals.daysWithTracks} days.\n\n` +
      `Nothing more lands here until you start or pick another trip. The family link keeps working:\n` +
      `${tripLink(trip)}\n\n` +
      `_/archive saves it as a file. Picking it again below reopens it._`,
    keyboard: new InlineKeyboard().text("🎒 Trips", encodeAction({ type: "trips" })),
    markdown: true,
  };
}

export function deleteTripConfirmView(trip: DbTrip): View {
  return {
    text:
      `🗑️ Delete *${escapeMd(trip.name)}* (${trip.start_date} → ${trip.end_date ?? "ongoing"})?\n\n` +
      `Its days, tracks, notes, photos and family page go for good. There is no undo.`,
    keyboard: new InlineKeyboard()
      .text("🗑 Yes, delete it forever", encodeAction({ type: "deletetrip", id: trip.id, confirmed: true }))
      .row()
      .text("Cancel", encodeAction({ type: "deletetrips" })),
    markdown: true,
  };
}

export function myPageConfirmView(): View {
  return {
    text:
      `🔗 New link for your permanent traveller page?\n\n` +
      `The current one stops working immediately — anyone you already sent it to ` +
      `sees nothing until they have the new one.`,
    keyboard: new InlineKeyboard()
      .text("🔗 Yes, new link", encodeAction({ type: "mypagelink", confirmed: true }))
      .row()
      .text("Cancel", encodeAction({ type: "status" })),
  };
}

export function relinkConfirmView(trip: DbTrip): View {
  return {
    text:
      `🔗 New family link for *${escapeMd(trip.name)}*?\n\n` +
      `The current one stops working the moment the new one exists — anyone you ` +
      `already sent it to needs the new one.\n\n${tripLink(trip)}`,
    keyboard: new InlineKeyboard()
      .text("🔗 Yes, new link", encodeAction({ type: "relink", confirmed: true }))
      .row()
      .text("Cancel", encodeAction({ type: "status" })),
    markdown: true,
  };
}
