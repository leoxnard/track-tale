import { InlineKeyboard } from "grammy";
import { supabase } from "./supabase.server";
import { deleteEntity } from "./entities.server";
import type { DbTrip } from "./db.server";
import { escapeMd } from "./telegram-md";
import {
  countSummary,
  encodeAction,
  KIND_ICON,
  KIND_NOUN,
  paginate,
  shortLabel,
  type ItemKind,
  type ManageItem,
} from "./manage";

/**
 * The screens behind `/manage`: a day picker, one day's contents, and a
 * confirmation. Each is a message body plus the inline keyboard that replaces
 * it, so the whole thing lives in a single message the traveller edits in
 * place rather than a trail of new ones.
 */

export interface View {
  text: string;
  keyboard: InlineKeyboard;
  /**
   * Only the views we compose ourselves. The confirmations quote the
   * traveller's own note or caption back at them, and an unbalanced `_` in
   * those makes Telegram reject the whole message.
   */
  markdown?: boolean;
  /** Confirming a photo shows it, and that needs the preview left switched on. */
  preview?: boolean;
}

interface DayRow {
  id: string;
  day_number: number;
  date: string;
  notes: { id: string }[];
  media: { id: string }[];
  track_segments: { id: string }[];
  comments: { id: string }[];
}

/** Days that hold something, newest day last — the order the trip happened in. */
async function loadDays(tripId: string): Promise<DayRow[]> {
  const { data, error } = await supabase()
    .from("days")
    .select("id, day_number, date, notes(id), media(id), track_segments(id), comments(id)")
    .eq("trip_id", tripId)
    .order("day_number");
  if (error) throw new Error(`could not load the trip's days: ${error.message}`);

  return ((data ?? []) as DayRow[]).filter(
    (d) => d.notes.length + d.media.length + d.track_segments.length + d.comments.length > 0,
  );
}

export async function overview(trip: DbTrip): Promise<View> {
  const days = await loadDays(trip.id);
  const keyboard = new InlineKeyboard();

  if (days.length === 0) {
    return {
      text:
        `*${escapeMd(trip.name)}* has nothing on it yet.\n\n` +
        `Send a track, a photo or a note first — then /manage can take it back off again.`,
      keyboard,
      markdown: true,
    };
  }

  for (const day of days) {
    const counts = {
      note: day.notes.length,
      media: day.media.length,
      track_segment: day.track_segments.length,
      comment: day.comments.length,
    };
    keyboard
      .text(
        `Day ${day.day_number} · ${countSummary(counts)}`,
        encodeAction({ type: "day", dayNumber: day.day_number, page: 0 }),
      )
      .row();
  }

  return {
    text:
      `🗂️ *${escapeMd(trip.name)}* — pick a day to see what's on it.\n\n` +
      `_Anything you delete here goes for good, photos and all._`,
    keyboard,
    markdown: true,
  };
}

/**
 * The `/replace` day picker: only days with photos on them, since a photo is
 * the only thing whose file can be swapped without the thing itself changing.
 */
export async function replaceOverview(trip: DbTrip): Promise<View> {
  const days = (await loadDays(trip.id)).filter((d) => d.media.length > 0);
  const keyboard = new InlineKeyboard();

  if (days.length === 0) {
    return {
      text:
        `*${escapeMd(trip.name)}* has no photos on it yet.\n\n` +
        `Send some first — then /replace can swap one for a better version.`,
      keyboard,
      markdown: true,
    };
  }

  for (const day of days) {
    keyboard
      .text(
        `Day ${day.day_number} · ${KIND_ICON.media} ${day.media.length}`,
        encodeAction({ type: "replaceDay", dayNumber: day.day_number, page: 0 }),
      )
      .row();
  }

  return {
    text:
      `🔄 *${escapeMd(trip.name)}* — pick a day, then the photo to swap.\n\n` +
      `_The new picture keeps the old one's caption, its pin on the map and its ` +
      `place in the day. Only the image changes._`,
    keyboard,
    markdown: true,
  };
}

/** One day's photos, each a button that arms the swap. */
export async function replaceDayView(
  trip: DbTrip,
  dayNumber: number,
  page: number,
): Promise<View> {
  const contents = await loadDayContents(trip, dayNumber);
  const photos = (contents?.items ?? []).filter((i) => i.kind === "media");
  const keyboard = new InlineKeyboard();

  if (photos.length === 0) {
    keyboard.text("◀︎ Days", encodeAction({ type: "replaceHome" }));
    return { text: `Day ${dayNumber} has no photos on it.`, keyboard, markdown: true };
  }

  const { items, page: current, pageCount } = paginate(photos, page);
  for (const item of items) {
    keyboard
      .text(
        `${KIND_ICON.media} ${item.label}`,
        encodeAction({ type: "replacePick", id: item.id, dayNumber }),
      )
      .row();
  }

  if (pageCount > 1) {
    if (current > 0) {
      keyboard.text(
        "‹ Previous",
        encodeAction({ type: "replaceDay", dayNumber, page: current - 1 }),
      );
    }
    if (current < pageCount - 1) {
      keyboard.text("Next ›", encodeAction({ type: "replaceDay", dayNumber, page: current + 1 }));
    }
    keyboard.row();
  }
  keyboard.text("◀︎ Days", encodeAction({ type: "replaceHome" }));

  const paging = pageCount > 1 ? ` — page ${current + 1}/${pageCount}` : "";
  return {
    text:
      `🔄 *Day ${dayNumber}* (${contents!.date}) — ${photos.length} photo(s)${paging}\n\n` +
      `Tap the one you want to swap.`,
    keyboard,
    markdown: true,
  };
}

/**
 * Picked, now waiting. The old picture is in the message on purpose: from here
 * the next photo sent into the chat replaces it, and that is worth being sure
 * about before reaching for the camera roll.
 */
export async function replacePromptView(
  trip: DbTrip,
  id: string,
  dayNumber: number,
): Promise<View | null> {
  if (!(await belongsToDay(trip, "media", id, dayNumber))) return null;

  const { data, error } = await supabase()
    .from("media")
    .select("caption, storage_path, thumb_path")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`could not load that photo: ${error.message}`);
  if (!data) return null;

  const url = supabase()
    .storage.from("photos")
    .getPublicUrl(data.thumb_path ?? data.storage_path).data.publicUrl;

  return {
    text:
      `🔄 Replacing this photo on day ${dayNumber}:\n` +
      (data.caption ? `“${data.caption}”\n` : "") +
      `${url}\n\n` +
      `Now send me the new picture. The next photo in this chat takes its place — ` +
      `send one, not an album.`,
    keyboard: new InlineKeyboard().text(
      "Cancel",
      encodeAction({ type: "replaceCancel", dayNumber }),
    ),
    preview: true,
  };
}

interface DayContents {
  dayId: string;
  date: string;
  items: ManageItem[];
}

async function loadDayContents(trip: DbTrip, dayNumber: number): Promise<DayContents | null> {
  const { data: day, error } = await supabase()
    .from("days")
    .select(
      "id, date, notes(id, text, created_at), media(id, caption, telegram_date), track_segments(id, name, distance_m, sport, started_at, created_at), comments(id, author_name, text, created_at)",
    )
    .eq("trip_id", trip.id)
    .eq("day_number", dayNumber)
    .maybeSingle();
  // Not the same as a day that isn't there. A refused query used to fall
  // through to "Day N is empty now." — a wrong answer, delivered confidently,
  // that looks from the chat exactly like the button doing nothing.
  if (error) throw new Error(`could not load day ${dayNumber}: ${error.message}`);
  if (!day) return null;

  const d = day as unknown as {
    id: string;
    date: string;
    notes: { id: string; text: string; created_at: string }[];
    media: { id: string; caption: string | null; telegram_date: string }[];
    track_segments: {
      id: string;
      name: string | null;
      distance_m: number;
      sport: string | null;
      started_at: string | null;
      created_at: string;
    }[];
    comments: { id: string; author_name: string; text: string; created_at: string }[];
  };

  const items: ManageItem[] = [
    ...d.track_segments.map((t) => ({
      kind: "track_segment" as ItemKind,
      id: t.id,
      label:
        shortLabel(t.name) ||
        `${(t.distance_m / 1000).toFixed(1)} km${t.sport ? ` · ${t.sport}` : ""}`,
      at: Date.parse(t.started_at ?? t.created_at) || 0,
    })),
    ...d.media.map((m, i) => ({
      kind: "media" as ItemKind,
      id: m.id,
      label: shortLabel(m.caption) || `photo ${i + 1}`,
      at: Date.parse(m.telegram_date) || 0,
    })),
    ...d.notes.map((n) => ({
      kind: "note" as ItemKind,
      id: n.id,
      label: shortLabel(n.text) || "(empty note)",
      at: Date.parse(n.created_at) || 0,
    })),
    ...d.comments.map((c) => ({
      kind: "comment" as ItemKind,
      id: c.id,
      label: shortLabel(`${c.author_name}: ${c.text}`),
      at: Date.parse(c.created_at) || 0,
    })),
  ].sort((a, b) => a.at - b.at);

  return { dayId: d.id, date: d.date, items };
}

export async function dayView(trip: DbTrip, dayNumber: number, page: number): Promise<View> {
  const contents = await loadDayContents(trip, dayNumber);
  const keyboard = new InlineKeyboard();

  if (!contents || contents.items.length === 0) {
    keyboard.text("◀︎ Days", encodeAction({ type: "home" }));
    return { text: `Day ${dayNumber} is empty now.`, keyboard, markdown: true };
  }

  const { items, page: current, pageCount } = paginate(contents.items, page);
  for (const item of items) {
    keyboard
      .text(
        `🗑 ${KIND_ICON[item.kind]} ${item.label}`,
        encodeAction({ type: "ask", kind: item.kind, id: item.id, dayNumber }),
      )
      .row();
  }

  if (pageCount > 1) {
    if (current > 0) {
      keyboard.text("‹ Previous", encodeAction({ type: "day", dayNumber, page: current - 1 }));
    }
    if (current < pageCount - 1) {
      keyboard.text("Next ›", encodeAction({ type: "day", dayNumber, page: current + 1 }));
    }
    keyboard.row();
  }
  keyboard.text("◀︎ Days", encodeAction({ type: "home" }));

  const paging = pageCount > 1 ? ` — page ${current + 1}/${pageCount}` : "";
  return {
    text:
      `📅 *Day ${dayNumber}* (${contents.date}) — ${contents.items.length} item(s)${paging}\n\n` +
      `Tap one to delete it.`,
    keyboard,
    markdown: true,
  };
}

export interface DayTally {
  notes: number;
  photos: number;
  tracks: number;
  /** Left alone by a clear: the family wrote these, not the traveller. */
  comments: number;
}

export function tallyTotal(tally: DayTally): number {
  return tally.notes + tally.photos + tally.tracks;
}

/** What `/clearday` would take off a day, without taking it off. */
export async function dayTally(trip: DbTrip, dayNumber: number): Promise<DayTally | null> {
  const contents = await loadDayContents(trip, dayNumber);
  if (!contents) return null;
  const count = (kind: ItemKind) => contents.items.filter((i) => i.kind === kind).length;
  return {
    notes: count("note"),
    photos: count("media"),
    tracks: count("track_segment"),
    comments: count("comment"),
  };
}

/**
 * Empty a day: every note, photo and track on it, in one go.
 *
 * Deleting a day's worth of items one button at a time is the wrong tool for
 * re-doing a day that was uploaded against the wrong day number, or built up
 * from files that turned out to be the wrong ones.
 *
 * Guestbook messages are deliberately left: they are the family's, not the
 * traveller's, and nothing about a re-upload makes them wrong. The day row
 * stays too, so the same day number keeps its date and colour when the
 * replacement lands on it.
 */
export async function clearDay(trip: DbTrip, dayNumber: number): Promise<DayTally | null> {
  const { data: day } = await supabase()
    .from("days")
    .select("id")
    .eq("trip_id", trip.id)
    .eq("day_number", dayNumber)
    .maybeSingle();
  if (!day) return null;

  const tally = await dayTally(trip, dayNumber);

  // Blobs before rows, so nothing is ever orphaned in the bucket with no row
  // left to name it.
  const { data: media } = await supabase()
    .from("media")
    .select("id, storage_path, thumb_path")
    .eq("day_id", day.id);
  const paths = (media ?? []).flatMap((m) =>
    [m.storage_path, m.thumb_path].filter(Boolean),
  ) as string[];
  if (paths.length > 0) await supabase().storage.from("photos").remove(paths);

  const ids: string[] = (media ?? []).map((m) => m.id);
  for (const table of ["media", "notes", "track_segments"] as const) {
    const { data: removed, error } = await supabase()
      .from(table)
      .delete()
      .eq("day_id", day.id)
      .select("id");
    if (error) throw error;
    for (const row of removed ?? []) if (!ids.includes(row.id)) ids.push(row.id);
  }

  // The confirmations in the chat now point at nothing.
  if (ids.length > 0) await supabase().from("bot_actions").delete().in("entity_id", ids);

  return tally;
}

/**
 * Is this id really one of the things listed on this trip's day?
 *
 * A button carries an id and nothing else, so without this a stale keyboard —
 * from a trip the chat has since switched away from, or from before /usetrip —
 * would delete out of whichever trip happens to be active now.
 */
async function belongsToDay(
  trip: DbTrip,
  kind: ItemKind,
  id: string,
  dayNumber: number,
): Promise<boolean> {
  const contents = await loadDayContents(trip, dayNumber);
  return (contents?.items ?? []).some((i) => i.kind === kind && i.id === id);
}

/** The second tap. Returns null when the item has gone in the meantime. */
export async function confirmView(
  trip: DbTrip,
  kind: ItemKind,
  id: string,
  dayNumber: number,
): Promise<View | null> {
  if (!(await belongsToDay(trip, kind, id, dayNumber))) return null;

  const keyboard = new InlineKeyboard()
    .text(`🗑 Yes, delete this ${KIND_NOUN[kind]}`, encodeAction({ type: "confirm", kind, id, dayNumber }))
    .row()
    .text("Cancel", encodeAction({ type: "day", dayNumber, page: 0 }));

  if (kind === "media") {
    const { data } = await supabase()
      .from("media")
      .select("caption, storage_path, thumb_path")
      .eq("id", id)
      .maybeSingle();
    if (!data) return null;
    const url = supabase()
      .storage.from("photos")
      .getPublicUrl(data.thumb_path ?? data.storage_path).data.publicUrl;
    return {
      // The link is the point: Telegram previews it, so the traveller sees
      // which photo this is before agreeing to lose it.
      text:
        `Delete this photo from day ${dayNumber}?\n` +
        (data.caption ? `“${data.caption}”\n` : "") +
        url,
      keyboard,
      preview: true,
    };
  }

  if (kind === "note") {
    const { data } = await supabase().from("notes").select("text").eq("id", id).maybeSingle();
    if (!data) return null;
    return {
      text: `Delete this note from day ${dayNumber}?\n\n“${shortLabel(data.text, 300)}”`,
      keyboard,
    };
  }

  if (kind === "comment") {
    const { data } = await supabase()
      .from("comments")
      .select("author_name, text")
      .eq("id", id)
      .maybeSingle();
    if (!data) return null;
    return {
      text:
        `Delete this guestbook message from day ${dayNumber}?\n\n` +
        `${data.author_name}: “${shortLabel(data.text, 300)}”`,
      keyboard,
    };
  }

  const { data } = await supabase()
    .from("track_segments")
    .select("name, distance_m, elevation_up")
    .eq("id", id)
    .maybeSingle();
  if (!data) return null;
  return {
    text:
      `Delete this track from day ${dayNumber}?\n\n` +
      `${data.name ? `${data.name} — ` : ""}${(data.distance_m / 1000).toFixed(1)} km, ` +
      `${Math.round(data.elevation_up)} m up.\n` +
      `The day's totals and the whole-tour chart drop it too.`,
    keyboard,
  };
}

/**
 * Do it. The item is deleted, then the day is redrawn so the traveller can
 * carry on clearing up without going back to the start.
 *
 * Returns null if the item is no longer on the day — a double tap on the
 * confirm button must not go looking for something else to delete.
 */
export async function applyDelete(
  trip: DbTrip,
  kind: ItemKind,
  id: string,
  dayNumber: number,
): Promise<View | null> {
  if (!(await belongsToDay(trip, kind, id, dayNumber))) return null;

  await deleteEntity(kind, id);
  const view = await dayView(trip, dayNumber, 0);
  return {
    ...view,
    text: `🗑️ ${KIND_ICON[kind]} ${KIND_NOUN[kind]} deleted.\n\n${view.text}`,
  };
}
