import { supabase } from "./supabase.server";
import { dayColor } from "./track";

export interface DbUser {
  telegram_id: number;
  display_name: string;
  is_owner: boolean;
}

export interface DbChat {
  chat_id: number;
  type: string;
  title: string | null;
  active_trip_id: string | null;
}

export interface DbTrip {
  id: string;
  chat_id: number;
  owner_telegram_id: number;
  name: string;
  start_date: string;
  end_date: string;
  timezone: string;
  share_slug: string;
  current_day_number: number | null;
  live_url: string | null;
  live_expires_at: string | null;
  finished_at: string | null;
  reminders_enabled: boolean;
  og_path: string | null;
  og_updated_at: string | null;
  archive_path: string | null;
  archived_at: string | null;
}

export interface DbDay {
  id: string;
  trip_id: string;
  day_number: number;
  date: string;
  color: string;
}

export async function getUser(telegramId: number): Promise<DbUser | null> {
  const { data } = await supabase()
    .from("users")
    .select("*")
    .eq("telegram_id", telegramId)
    .maybeSingle();
  return data;
}

export async function createUser(
  telegramId: number,
  displayName: string,
  isOwner: boolean,
): Promise<DbUser> {
  const { data, error } = await supabase()
    .from("users")
    .insert({ telegram_id: telegramId, display_name: displayName, is_owner: isOwner })
    .select()
    .single();
  if (error) throw error;
  return data;
}

/** How long an unused invite code stays redeemable. */
export const INVITE_TTL_DAYS = 7;

export async function redeemInvite(code: string, telegramId: number): Promise<boolean> {
  // The expiry check rides along in the update, so a code cannot be redeemed by
  // two people racing each other past a separate read.
  const { data } = await supabase()
    .from("invites")
    .update({ used_by: telegramId })
    .eq("code", code)
    .is("used_by", null)
    .gt("expires_at", new Date().toISOString())
    .select()
    .maybeSingle();
  return data !== null;
}

/** Returns the expiry stamped on the new code. */
export async function createInvite(code: string, createdBy: number): Promise<Date> {
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86400000);
  const { error } = await supabase()
    .from("invites")
    .insert({ code, created_by: createdBy, expires_at: expiresAt.toISOString() });
  if (error) throw error;
  return expiresAt;
}

/** Get or create the chat record for a Telegram chat (private or group). */
export async function ensureChat(
  chatId: number,
  type: string,
  title?: string,
): Promise<DbChat> {
  const existing = await supabase()
    .from("chats")
    .select("*")
    .eq("chat_id", chatId)
    .maybeSingle();
  if (existing.data) {
    // Group titles change; keep ours current without an extra round trip elsewhere.
    if (title && title !== existing.data.title) {
      await supabase().from("chats").update({ title }).eq("chat_id", chatId);
      existing.data.title = title;
    }
    return existing.data;
  }

  const { data, error } = await supabase()
    .from("chats")
    .insert({ chat_id: chatId, type, title: title ?? null })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function chatHasTrips(chatId: number): Promise<boolean> {
  const { count } = await supabase()
    .from("trips")
    .select("*", { count: "exact", head: true })
    .eq("chat_id", chatId);
  return (count ?? 0) > 0;
}

export async function createTrip(trip: {
  chat_id: number;
  owner_telegram_id: number;
  name: string;
  start_date: string;
  end_date: string;
  share_slug: string;
  timezone?: string;
}): Promise<DbTrip> {
  const { data, error } = await supabase().from("trips").insert(trip).select().single();
  if (error) throw error;
  await setActiveTrip(trip.chat_id, data.id);
  return data;
}

export async function getTrip(tripId: string): Promise<DbTrip | null> {
  const { data } = await supabase().from("trips").select("*").eq("id", tripId).maybeSingle();
  return data;
}

export async function getTripBySlug(slug: string): Promise<DbTrip | null> {
  const { data } = await supabase().from("trips").select("*").eq("share_slug", slug).maybeSingle();
  return data;
}

/** The trip that uploads in this chat currently land on. */
export async function getActiveTrip(chat: DbChat): Promise<DbTrip | null> {
  if (!chat.active_trip_id) return null;
  return getTrip(chat.active_trip_id);
}

export async function listTrips(chatId: number): Promise<DbTrip[]> {
  const { data } = await supabase()
    .from("trips")
    .select("*")
    .eq("chat_id", chatId)
    .order("start_date", { ascending: false });
  return data ?? [];
}

export async function updateTrip(tripId: string, patch: Partial<DbTrip>): Promise<void> {
  const { error } = await supabase().from("trips").update(patch).eq("id", tripId);
  if (error) throw error;
}

/**
 * Mark a trip finished and stop it receiving uploads. The pages, links and
 * archive all keep working — the chat simply has no active trip any more.
 */
export async function finishTrip(trip: DbTrip): Promise<void> {
  await updateTrip(trip.id, {
    finished_at: new Date().toISOString(),
    live_url: null,
    live_expires_at: null,
  });
  const { error } = await supabase()
    .from("chats")
    .update({ active_trip_id: null })
    .eq("chat_id", trip.chat_id)
    .eq("active_trip_id", trip.id);
  if (error) throw error;
}

/** Undo /endtrip, so a trip that ended early can be written to again. */
export async function reopenTrip(trip: DbTrip): Promise<void> {
  await updateTrip(trip.id, { finished_at: null });
  await setActiveTrip(trip.chat_id, trip.id);
}

/**
 * Delete every object under a storage prefix. Supabase lists one directory at a
 * time and returns folders as entries with no id, so this walks them itself.
 */
async function removeStoragePrefix(bucket: string, prefix: string): Promise<void> {
  const store = supabase().storage.from(bucket);
  // Deleting shrinks the listing, so page by re-reading the front of it.
  for (;;) {
    const { data: entries } = await store.list(prefix, { limit: 100 });
    if (!entries || entries.length === 0) return;

    const files: string[] = [];
    for (const entry of entries) {
      const path = `${prefix}/${entry.name}`;
      if (entry.id === null) await removeStoragePrefix(bucket, path);
      else files.push(path);
    }
    if (files.length > 0) {
      await store.remove(files);
    } else {
      // Nothing but folders, and they have now been emptied — one more list
      // would either come back empty or reveal something we cannot remove.
      return;
    }
  }
}

/**
 * Irreversibly delete a trip. Days, tracks, photos rows, notes and comments go
 * with it through the cascades; the stored blobs have to be swept by hand.
 */
export async function deleteTrip(trip: DbTrip): Promise<void> {
  await removeStoragePrefix("photos", trip.id);
  await removeStoragePrefix("archives", trip.id);
  if (trip.og_path) await supabase().storage.from("photos").remove([trip.og_path]);

  const { error } = await supabase().from("trips").delete().eq("id", trip.id);
  if (error) throw error;
}

/** The highest day number that already holds something. 0 when the trip is empty. */
export async function lastUsedDayNumber(tripId: string): Promise<number> {
  const { data } = await supabase()
    .from("days")
    .select("day_number, track_segments(id), media(id), notes(id)")
    .eq("trip_id", tripId);

  let last = 0;
  for (const day of data ?? []) {
    const d = day as {
      day_number: number;
      track_segments: unknown[];
      media: unknown[];
      notes: unknown[];
    };
    const used = d.track_segments.length + d.media.length + d.notes.length > 0;
    if (used && d.day_number > last) last = d.day_number;
  }
  return last;
}

/**
 * Drop day rows that fall off the end of a shortened trip. Only ever called for
 * days confirmed empty, so the cascades have nothing to take with them.
 */
export async function pruneDaysBeyond(tripId: string, lastDayNumber: number): Promise<void> {
  const { error } = await supabase()
    .from("days")
    .delete()
    .eq("trip_id", tripId)
    .gt("day_number", lastDayNumber);
  if (error) throw error;
}

/** Re-date existing day rows after the trip's start date moved. */
export async function realignDayDates(trip: DbTrip): Promise<void> {
  const { data: days } = await supabase()
    .from("days")
    .select("id, day_number")
    .eq("trip_id", trip.id);

  for (const day of days ?? []) {
    const date = new Date(trip.start_date + "T00:00:00Z");
    date.setUTCDate(date.getUTCDate() + day.day_number - 1);
    await supabase()
      .from("days")
      .update({ date: date.toISOString().slice(0, 10) })
      .eq("id", day.id);
  }
}

export async function setActiveTrip(chatId: number, tripId: string): Promise<void> {
  const { error } = await supabase()
    .from("chats")
    .update({ active_trip_id: tripId })
    .eq("chat_id", chatId);
  if (error) throw error;
}

/** Get or create the day row for a trip day number. */
export async function ensureDay(trip: DbTrip, dayNumber: number): Promise<DbDay> {
  const existing = await supabase()
    .from("days")
    .select("*")
    .eq("trip_id", trip.id)
    .eq("day_number", dayNumber)
    .maybeSingle();
  if (existing.data) return existing.data;

  const date = new Date(trip.start_date + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + dayNumber - 1);
  const { data, error } = await supabase()
    .from("days")
    .insert({
      trip_id: trip.id,
      day_number: dayNumber,
      date: date.toISOString().slice(0, 10),
      color: dayColor(dayNumber),
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export function tripDayCount(trip: DbTrip): number {
  const start = Date.parse(trip.start_date);
  const end = Date.parse(trip.end_date);
  return Math.round((end - start) / 86400000) + 1;
}
