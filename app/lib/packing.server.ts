import { supabase } from "./supabase.server";
import type { PackFields } from "./packing";

/**
 * The packing list and the conversation that fills it in, against the database.
 *
 * Rows come back in the order they were typed: a packing list is written as it
 * is packed, and re-sorting it alphabetically would lose the grouping the
 * traveller had in their head — tent, pegs, footprint, then the kitchen. The
 * categories do the grouping instead, and they too keep the order they first
 * appeared in.
 */

export interface PackItem extends PackFields {
  id: string;
  author: string | null;
}

interface PackRow {
  id: string;
  title: string;
  model: string | null;
  url: string | null;
  category: string | null;
  author_name: string | null;
}

const COLUMNS = "id, title, model, url, category, author_name";

function toItem(row: PackRow): PackItem {
  return {
    id: row.id,
    title: row.title,
    model: row.model,
    url: row.url,
    category: row.category,
    author: row.author_name,
  };
}

export async function listPackItems(tripId: string): Promise<PackItem[]> {
  const { data } = await supabase()
    .from("pack_items")
    .select(COLUMNS)
    .eq("trip_id", tripId)
    .order("created_at");
  return ((data ?? []) as PackRow[]).map(toItem);
}

/** One thing packed. Returns the new row's id, which the chat needs to undo it. */
export async function addPackItem(
  tripId: string,
  fields: PackFields,
  author: { id?: number; name?: string },
): Promise<string> {
  const { data, error } = await supabase()
    .from("pack_items")
    .insert({
      trip_id: tripId,
      title: fields.title,
      model: fields.model,
      url: fields.url,
      category: fields.category,
      author_telegram_id: author.id ?? null,
      author_name: author.name ?? null,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

/** One item, for the screen that is about to change or delete it. */
export async function getPackItem(tripId: string, id: string): Promise<PackItem | null> {
  const { data } = await supabase()
    .from("pack_items")
    .select(COLUMNS)
    .eq("trip_id", tripId)
    .eq("id", id)
    .maybeSingle();
  return data ? toItem(data as PackRow) : null;
}

/** Which field of an entry an answer belongs in. */
export type PackField = "title" | "model" | "url" | "category";

/**
 * Change one field of one entry, scoped to the trip.
 *
 * The trip is in the `where` rather than checked first: a button can outlive
 * the trip it was sent in, and an id from another chat's list must not become
 * an edit just because it parsed.
 */
export async function updatePackItem(
  tripId: string,
  id: string,
  field: PackField,
  value: string | null,
): Promise<boolean> {
  // The title is what names the thing; emptying it would leave a row that the
  // page draws as a blank line, so that one answer is refused rather than saved.
  if (field === "title" && value === null) return false;
  const { data, error } = await supabase()
    .from("pack_items")
    .update({ [field]: value })
    .eq("trip_id", tripId)
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}

/**
 * How long the bot waits for an answer before the question lapses.
 *
 * The conversation costs a chat its ordinary meaning of a plain message — while
 * one is open, text is a packing list answer rather than a journal note. Left
 * open indefinitely that would quietly eat tomorrow's first note, so an
 * abandoned question expires and the chat goes back to normal on its own.
 */
export const PACK_SESSION_MS = 30 * 60 * 1000;

/** What the chat is currently being asked. */
export type PackStep = "title" | "model" | "url" | "category" | "edit";

export interface PackSession {
  tripId: string;
  step: PackStep;
  /** The entry being built, as far as it has got. */
  draft: PackFields;
  /** Set instead of the draft when an existing entry is being changed. */
  itemId: string | null;
  field: PackField | null;
}

interface SessionRow {
  trip_id: string;
  step: PackStep;
  title: string | null;
  model: string | null;
  url: string | null;
  category: string | null;
  item_id: string | null;
  field: PackField | null;
  created_at: string;
}

/**
 * Ask this chat something, replacing whatever it was being asked before.
 *
 * `created_at` is written explicitly: an upsert over an existing row keeps the
 * old default, so a second question would inherit the first one's deadline.
 */
export async function setPackSession(
  chatId: number,
  session: PackSession,
): Promise<void> {
  const { error } = await supabase()
    .from("pack_sessions")
    .upsert(
      {
        chat_id: chatId,
        trip_id: session.tripId,
        step: session.step,
        title: session.draft.title || null,
        model: session.draft.model,
        url: session.draft.url,
        category: session.draft.category,
        item_id: session.itemId,
        field: session.field,
        created_at: new Date().toISOString(),
      },
      { onConflict: "chat_id" },
    );
  if (error) throw new Error(`could not open the packing question: ${error.message}`);
}

export async function clearPackSession(chatId: number): Promise<void> {
  await supabase().from("pack_sessions").delete().eq("chat_id", chatId);
}

/** What this chat is being asked, or null — including for a question gone stale. */
export async function getPackSession(chatId: number): Promise<PackSession | null> {
  const { data } = await supabase()
    .from("pack_sessions")
    .select("trip_id, step, title, model, url, category, item_id, field, created_at")
    .eq("chat_id", chatId)
    .maybeSingle();
  if (!data) return null;

  const row = data as SessionRow;
  if (Date.now() - Date.parse(row.created_at) > PACK_SESSION_MS) {
    await clearPackSession(chatId);
    return null;
  }
  return {
    tripId: row.trip_id,
    step: row.step,
    draft: {
      title: row.title ?? "",
      model: row.model,
      url: row.url,
      category: row.category,
    },
    itemId: row.item_id,
    field: row.field,
  };
}
