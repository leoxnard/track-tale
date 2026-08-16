import { supabase } from "./supabase.server";
import type { PackFields } from "./packing";

/**
 * The packing list, against the database.
 *
 * Rows in the order they were typed: a packing list is written as it is packed,
 * and re-sorting it alphabetically would lose the grouping the traveller had in
 * their head — tent, pegs, footprint, then the kitchen.
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
  author_name: string | null;
}

export async function listPackItems(tripId: string): Promise<PackItem[]> {
  const { data } = await supabase()
    .from("pack_items")
    .select("id, title, model, url, author_name")
    .eq("trip_id", tripId)
    .order("created_at");
  return ((data ?? []) as PackRow[]).map((r) => ({
    id: r.id,
    title: r.title,
    model: r.model,
    url: r.url,
    author: r.author_name,
  }));
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
      author_telegram_id: author.id ?? null,
      author_name: author.name ?? null,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

/** One item, for the confirmation screen that is about to delete it. */
export async function getPackItem(tripId: string, id: string): Promise<PackItem | null> {
  const { data } = await supabase()
    .from("pack_items")
    .select("id, title, model, url, author_name")
    .eq("trip_id", tripId)
    .eq("id", id)
    .maybeSingle();
  if (!data) return null;
  const row = data as PackRow;
  return { id: row.id, title: row.title, model: row.model, url: row.url, author: row.author_name };
}
