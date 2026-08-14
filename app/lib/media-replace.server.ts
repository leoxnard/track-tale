import { nanoid } from "nanoid";
import { supabase } from "./supabase.server";

/**
 * Swapping the picture behind a photo, without the photo becoming a different
 * one.
 *
 * Re-editing a trip's photos — a filter over the lot of them — used to mean
 * deleting each and sending it again, which loses the caption, the pin the
 * photo earned by matching the day's track, its place in the day's order and
 * who took it. All of that is worth more than the file, so a replacement keeps
 * the row and changes only what it points at.
 *
 * Nothing here knows about Telegram: the bytes arrive already downloaded, which
 * keeps the part worth testing free of a network.
 */

/**
 * How long a picked photo waits for its replacement.
 *
 * The pick and the picture are two separate updates with nothing linking them,
 * so the next photo in the chat is taken to be the one meant. That is only a
 * safe assumption while the tap is still fresh in mind — a pick left overnight
 * would silently eat tomorrow morning's first upload.
 */
export const REPLACE_WINDOW_MS = 60 * 60 * 1000;

export interface PendingReplacement {
  mediaId: string;
  dayNumber: number;
}

/** Remember which photo this chat is about to swap. One at a time per chat. */
export async function armReplacement(
  chatId: number,
  mediaId: string,
  dayNumber: number,
  requestedBy: number,
): Promise<void> {
  const { error } = await supabase()
    .from("pending_replacements")
    .upsert(
      {
        chat_id: chatId,
        media_id: mediaId,
        day_number: dayNumber,
        requested_by: requestedBy,
        // Explicit rather than left to the column default: an upsert over an
        // existing row keeps the old default, and a second pick has to restart
        // the clock or it inherits the first one's deadline.
        created_at: new Date().toISOString(),
      },
      { onConflict: "chat_id" },
    );
  if (error) throw new Error(`could not arm the replacement: ${error.message}`);
}

export async function clearReplacement(chatId: number): Promise<void> {
  await supabase().from("pending_replacements").delete().eq("chat_id", chatId);
}

/**
 * Is this chat waiting for a replacement picture?
 *
 * A pick that has gone stale is cleared rather than honoured, so the photo that
 * follows it is treated as the ordinary upload the sender almost certainly
 * meant.
 */
export async function pendingReplacement(chatId: number): Promise<PendingReplacement | null> {
  const { data, error } = await supabase()
    .from("pending_replacements")
    .select("media_id, day_number, created_at")
    .eq("chat_id", chatId)
    .maybeSingle();
  if (error) throw new Error(`could not check for a pending replacement: ${error.message}`);
  if (!data) return null;

  if (Date.now() - Date.parse(data.created_at) > REPLACE_WINDOW_MS) {
    await clearReplacement(chatId);
    return null;
  }
  return { mediaId: data.media_id, dayNumber: data.day_number };
}

export interface ReplacementFiles {
  full: ArrayBuffer | Uint8Array;
  /** Null when Telegram offered no smaller size worth keeping separately. */
  thumb: ArrayBuffer | Uint8Array | null;
  /** A caption on the new picture replaces the old one; without one it stays. */
  caption: string | null;
  /**
   * How to store the new bytes. Defaults to JPEG, which is what Telegram's
   * compressed photos always are; a photo sent as a file brings its own format.
   */
  format?: { extension: string; contentType: string };
  /**
   * Fingerprint of the new picture. Without refreshing it the row keeps
   * describing the picture it used to hold.
   */
  phash?: string | null;
}

/**
 * Put new bytes behind an existing photo. Returns false if the row has gone in
 * the meantime — deleted from another chat, or by the `/manage` screen still
 * open in the same one.
 *
 * The new files get new names rather than overwriting the old ones. The family
 * page, Telegram's link previews and any CDN in front of the bucket all cache
 * by URL, so an overwrite is the one way to do this that reliably shows
 * everybody the *old* picture afterwards.
 */
export async function replacePhoto(mediaId: string, files: ReplacementFiles): Promise<boolean> {
  const { data: existing, error: readError } = await supabase()
    .from("media")
    .select("storage_path, thumb_path, caption")
    .eq("id", mediaId)
    .maybeSingle();
  if (readError) throw new Error(`could not load that photo: ${readError.message}`);
  if (!existing) return false;

  // Same folder as before — that is where the trip and day live in the path, and
  // a replacement belongs to the same day as the photo it replaces.
  const dir = existing.storage_path.includes("/")
    ? existing.storage_path.slice(0, existing.storage_path.lastIndexOf("/"))
    : "";
  const base = dir ? `${dir}/${nanoid(8)}` : nanoid(8);
  const store = supabase().storage.from("photos");

  const format = files.format ?? { extension: ".jpg", contentType: "image/jpeg" };
  const fullPath = `${base}${format.extension}`;
  const up = await store.upload(fullPath, files.full, { contentType: format.contentType });
  if (up.error) throw up.error;

  const written: string[] = [fullPath];
  let thumbPath: string | null = null;
  if (files.thumb) {
    thumbPath = `${base}-thumb.jpg`;
    const upThumb = await store.upload(thumbPath, files.thumb, { contentType: "image/jpeg" });
    // A missing thumbnail is survivable — the page falls back to the full
    // image, exactly as it does for photos uploaded without one.
    if (upThumb.error) thumbPath = null;
    else written.push(thumbPath);
  }

  // `motion_path` is deliberately absent: a Live Photo edited in Lightroom
  // comes back as a still, because that is all an editor exports, and the three
  // seconds behind it are still a recording of this shot. Rewriting the
  // fingerprint while keeping the video is the point — a later re-send of the
  // same picture is matched against the edit, which is what is on the page now.
  const { data: updated, error } = await supabase()
    .from("media")
    .update({
      storage_path: fullPath,
      thumb_path: thumbPath,
      caption: files.caption ?? existing.caption,
      ...(files.phash ? { phash: files.phash } : {}),
    })
    .eq("id", mediaId)
    .select("id");
  if (error) {
    // Don't strand what was just uploaded: the row still points at the old
    // files, so these are referenced by nothing.
    await store.remove(written);
    throw error;
  }
  // Deleted between the read and the write. Same cleanup, same reason.
  if ((updated ?? []).length === 0) {
    await store.remove(written);
    return false;
  }

  // Only now: while the row still pointed at them, deleting these would have
  // left the photo showing nothing at all if the update had failed.
  const old = [existing.storage_path, existing.thumb_path].filter(
    (p): p is string => Boolean(p) && !written.includes(p as string),
  );
  if (old.length > 0) await store.remove(old);

  return true;
}
