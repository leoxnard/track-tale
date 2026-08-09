import sharp from "sharp";

/**
 * A photo sent as a *file* arrives as the camera or Lightroom wrote it —
 * 8 MB and 6000 px wide is normal. That is what makes its EXIF worth having,
 * and also what makes the family page crawl: the lightbox pulls the whole
 * thing down before showing anything.
 *
 * So the bytes we read metadata from and the bytes we serve are two different
 * things. Metadata comes off the original; what gets stored is a copy sized
 * for a screen.
 */

/** Long edge of the picture behind the lightbox. Comfortably retina at full width. */
const DISPLAY_MAX_EDGE = 2048;
const DISPLAY_QUALITY = 80;
/** Long edge of the grid tile and the map marker. */
const THUMB_MAX_EDGE = 480;
const THUMB_QUALITY = 70;

/**
 * Anything at or under this is already web-sized — Telegram's own compressed
 * photos land around 200 kB — and re-encoding it would only lose detail.
 */
export const COMPRESS_ABOVE_BYTES = 1_200_000;

export interface WebImage {
  display: Uint8Array;
  thumb: Uint8Array;
  /** Bytes of the stored picture, for reporting how much was saved. */
  displayBytes: number;
}

const encode = (input: ArrayBuffer | Uint8Array, maxEdge: number, quality: number) =>
  sharp(input instanceof Uint8Array ? input : new Uint8Array(input))
    // Phones record orientation in EXIF rather than rotating pixels. Bake it in
    // here, because the copy we write carries no EXIF for a viewer to consult.
    .rotate()
    .resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();

/**
 * Screen-sized JPEG plus a grid thumbnail. Both are stripped of metadata,
 * which sharp does by default — the GPS fix is already saved to the database
 * by the time this runs, and a public page has no business handing out the
 * co-ordinates of someone's home a second time.
 */
export async function compressForWeb(original: ArrayBuffer): Promise<WebImage> {
  const [display, thumb] = await Promise.all([
    encode(original, DISPLAY_MAX_EDGE, DISPLAY_QUALITY),
    encode(original, THUMB_MAX_EDGE, THUMB_QUALITY),
  ]);
  return {
    display: new Uint8Array(display),
    thumb: new Uint8Array(thumb),
    displayBytes: display.byteLength,
  };
}

/** Rough, for chat messages: "8.1 MB" rather than a byte count. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${Math.round(bytes / 1000)} kB`;
}
