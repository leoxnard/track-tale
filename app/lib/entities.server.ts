import { supabase } from "./supabase.server";

/**
 * Removing a single thing a traveller added.
 *
 * Shared by the two ways to get rid of something: the reply-based `/undo` and
 * `/delete` in bot.server, which reach the row through the confirmation message
 * that created it, and `/manage`, which browses days and deletes items that are
 * long past having a confirmation message to reply to.
 */

export type EntityType = "note" | "media" | "track_segment" | "plan_segment" | "comment";

export const ENTITY_TABLE: Record<EntityType, string> = {
  note: "notes",
  media: "media",
  track_segment: "track_segments",
  plan_segment: "plan_segments",
  comment: "comments",
};

export const ENTITY_LABEL: Record<EntityType, string> = {
  note: "Note",
  media: "Photo",
  track_segment: "Track",
  plan_segment: "Plan segment",
  comment: "Comment",
};

/**
 * Delete one row, and for a photo the stored blobs with it.
 *
 * The blobs go first: a row left behind by a failed delete still points at
 * something, whereas a row deleted before its files would strand them in the
 * bucket with nothing left to name them.
 */
export async function deleteEntity(entityType: EntityType, entityId: string): Promise<void> {
  if (entityType === "media") {
    const { data } = await supabase()
      .from("media")
      .select("storage_path, thumb_path")
      .eq("id", entityId)
      .maybeSingle();
    const paths = [data?.storage_path, data?.thumb_path].filter(Boolean) as string[];
    if (paths.length > 0) await supabase().storage.from("photos").remove(paths);
  }

  const { error } = await supabase().from(ENTITY_TABLE[entityType]).delete().eq("id", entityId);
  if (error) throw error;

  // The confirmation message that created this row is now a dead reference;
  // leaving it would let a later /delete reply claim to remove it a second time.
  await supabase().from("bot_actions").delete().eq("entity_id", entityId);
}
