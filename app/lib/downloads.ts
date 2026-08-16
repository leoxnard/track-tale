/**
 * The download centre's file names, on their own so both halves agree on them.
 *
 * The page builds links out of these and the resource route parses the same
 * strings back — which is why the name in the URL is the *whole* request. There
 * is no query string and no id: `/t/<slug>/download/day-3-photos.zip` says what
 * it is in the one place a browser also shows the reader, and a link copied out
 * of the page still says what it will save.
 *
 * The file the browser writes to disk is named separately (`attachmentName`),
 * because "day-3.gpx" in a downloads folder six months later is nothing at all
 * — it wants the trip's name on it.
 */

/** What the reader asked for: a track or the pictures, for one day or the lot. */
export interface DownloadRequest {
  kind: "gpx" | "photos";
  /** A day number, or null for the whole trip. */
  day: number | null;
}

/** The name that goes in the URL. Inverse of `parseDownloadFile`. */
export function downloadFileName(req: DownloadRequest): string {
  const stem = req.day === null ? "trip" : `day-${req.day}`;
  return req.kind === "gpx" ? `${stem}.gpx` : `${stem === "trip" ? "photos" : `${stem}-photos`}.zip`;
}

/**
 * Read a request back off the URL, or null if it is not one of ours.
 *
 * Strict on purpose: the day number is what reaches the database, so anything
 * but plain digits is refused here rather than coerced into a NaN further in.
 */
export function parseDownloadFile(file: string): DownloadRequest | null {
  if (file === "trip.gpx") return { kind: "gpx", day: null };
  if (file === "photos.zip") return { kind: "photos", day: null };

  const gpx = /^day-(\d{1,4})\.gpx$/.exec(file);
  if (gpx) return { kind: "gpx", day: Number(gpx[1]) };

  const zip = /^day-(\d{1,4})-photos\.zip$/.exec(file);
  if (zip) return { kind: "photos", day: Number(zip[1]) };

  return null;
}

/**
 * A trip name reduced to something safe in a file name on any system —
 * lowercase, ASCII, hyphen-separated. Empty names and names made entirely of
 * punctuation fall back to "trip" rather than producing a file called ".gpx".
 */
export function slugifyName(name: string): string {
  const slug = name
    .toLowerCase()
    // Strip the accents rather than dropping the letters: "Rhône" reads better
    // as "rhone" than as "rh-ne".
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    // Not a letter with an accent on it, so decomposition never reaches it.
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "trip";
}

/** What the browser saves it as: the trip, then which part of it. */
export function attachmentName(tripName: string, req: DownloadRequest): string {
  const base = slugifyName(tripName);
  const part = req.day === null ? "" : `-day-${req.day}`;
  return req.kind === "gpx" ? `${base}${part}.gpx` : `${base}${part}-photos.zip`;
}
