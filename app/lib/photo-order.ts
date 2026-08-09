/**
 * The order a day's photos are shown in.
 *
 * Upload time is a poor stand-in for when a picture was taken: a day's worth
 * of photos sent in one batch from the hotel all share a send timestamp to the
 * second, which leaves their order undefined. EXIF capture time is the real
 * answer whenever the file carried it, so it comes first.
 */

export interface OrderablePhoto {
  /** EXIF capture time, when the photo arrived as a file that had one. */
  taken_at?: string | null;
  /** When the message reached the bot. Always present. */
  telegram_date: string;
  /** Insert order, the last resort that keeps a batch from shuffling. */
  created_at?: string | null;
}

const parse = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};

/** When the photo happened, as best as the record allows. */
export function photoTimeMs(photo: OrderablePhoto): number {
  return parse(photo.taken_at) ?? parse(photo.telegram_date) ?? parse(photo.created_at) ?? 0;
}

/**
 * Chronological, with upload order breaking ties. Without the tiebreak a batch
 * sharing one send timestamp comes back in whatever order the database felt
 * like, and the page reshuffles between visits.
 */
export function byPhotoTime(a: OrderablePhoto, b: OrderablePhoto): number {
  const diff = photoTimeMs(a) - photoTimeMs(b);
  if (diff !== 0) return diff;
  return (parse(a.created_at) ?? 0) - (parse(b.created_at) ?? 0);
}

/** True when the photo's place in the day rests on a real capture time. */
export function hasCaptureTime(photo: OrderablePhoto): boolean {
  return parse(photo.taken_at) !== null;
}
