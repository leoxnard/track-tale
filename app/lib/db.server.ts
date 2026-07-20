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

export async function redeemInvite(code: string, telegramId: number): Promise<boolean> {
  const { data } = await supabase()
    .from("invites")
    .update({ used_by: telegramId })
    .eq("code", code)
    .is("used_by", null)
    .select()
    .maybeSingle();
  return data !== null;
}

export async function createInvite(code: string, createdBy: number): Promise<void> {
  const { error } = await supabase().from("invites").insert({ code, created_by: createdBy });
  if (error) throw error;
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
