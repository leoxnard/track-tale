/**
 * How a photo sent as a Telegram *document* should be stored.
 *
 * Sending a photo uncompressed is the only way its EXIF survives, so this path
 * matters — but it also means the bot receives whatever the phone had lying
 * around, including formats no browser will render.
 */
export interface ImageDocument {
  extension: string;
  contentType: string;
  /** Whether reading EXIF out of these bytes is worth attempting. */
  keepsExif: boolean;
}

/**
 * Classifies a document: a storable image, "unreadable" for an image format
 * the family's browsers would refuse (HEIC above all, which is what an iPhone
 * hands over untouched), or null for anything that is not a picture.
 *
 * Telegram usually supplies a MIME type; when it doesn't, fall back to the
 * file name.
 */
export function imageDocument(
  mimeType: string | undefined,
  fileName: string,
): ImageDocument | "unreadable" | null {
  const mime = (mimeType ?? "").toLowerCase().trim();
  const name = fileName.toLowerCase();
  const matches = (extensions: string[], ...mimes: string[]) =>
    mimes.includes(mime) || (mime === "" && extensions.some((e) => name.endsWith(e)));

  if (matches([".jpg", ".jpeg"], "image/jpeg", "image/jpg")) {
    return { extension: ".jpg", contentType: "image/jpeg", keepsExif: true };
  }
  if (matches([".png"], "image/png")) {
    // PNGs rarely carry EXIF, but parsing costs nothing and some editors add it.
    return { extension: ".png", contentType: "image/png", keepsExif: true };
  }
  if (matches([".heic", ".heif"], "image/heic", "image/heif")) return "unreadable";
  return mime.startsWith("image/") ? "unreadable" : null;
}
