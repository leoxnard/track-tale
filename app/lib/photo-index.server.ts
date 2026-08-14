import { supabase } from "./supabase.server";
import { perceptualHash, type HashedPhoto } from "./phash";

/**
 * Fingerprints for a set of stored photos, computing the ones that are missing
 * as it goes.
 *
 * Two features need this and neither should own it: recognising an edited
 * re-upload as a photo already on the trip (`bot-photos`), and recognising
 * which photo a Live Photo's video belongs to (`bot-motion`). Keeping it here
 * also keeps those two from importing each other, which they otherwise would in
 * a circle.
 *
 * Hashes are read off the stored thumbnail — 20 kB rather than a whole picture,
 * and a difference hash gives the same answer either way — and written back, so
 * the trip pays for each photo once.
 */

export interface IndexablePhoto {
  id: string;
  phash: string | null;
  thumb_path: string | null;
  storage_path: string;
}

export async function hashPhotos(rows: IndexablePhoto[]): Promise<HashedPhoto[]> {
  const store = supabase().storage.from("photos");
  const hashed: HashedPhoto[] = [];
  for (const photo of rows) {
    if (photo.phash) {
      hashed.push({ id: photo.id, hash: photo.phash });
      continue;
    }
    try {
      const { data: blob } = await store.download(photo.thumb_path ?? photo.storage_path);
      if (!blob) continue;
      const hash = await perceptualHash(await blob.arrayBuffer());
      await supabase().from("media").update({ phash: hash }).eq("id", photo.id);
      hashed.push({ id: photo.id, hash });
    } catch {
      // A photo we cannot read simply isn't a candidate.
    }
  }
  return hashed;
}
