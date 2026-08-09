/**
 * Minimal EXIF reader for JPEGs, just enough to place a photo on the map.
 *
 * Telegram re-encodes compressed photos and drops their metadata, but a photo
 * sent as a *file* arrives byte-for-byte, so a camera's own GPS fix and capture
 * time survive the trip. Those beat guessing from the send timestamp.
 *
 * Only the tags we act on are decoded; everything else is skipped.
 */

export interface ExifData {
  /** Decimal degrees, north/east positive. Both set or both absent. */
  lat?: number;
  lng?: number;
  /**
   * Capture time as an absolute instant. Only set when the file pins down a
   * UTC offset — either a GPS timestamp or OffsetTimeOriginal. A bare
   * DateTimeOriginal is local wall-clock with no zone, and reading it as UTC
   * would drop a photo hours off the route, so we leave it out.
   */
  takenAtMs?: number;
}

// TIFF/EXIF tag ids we care about.
const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_GPS_LAT_REF = 0x0001;
const TAG_GPS_LAT = 0x0002;
const TAG_GPS_LNG_REF = 0x0003;
const TAG_GPS_LNG = 0x0004;
const TAG_GPS_TIME = 0x0007;
const TAG_GPS_DATE = 0x001d;
const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_OFFSET_TIME_ORIGINAL = 0x9011;

const TYPE_BYTE_SIZE: Record<number, number> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  7: 1, // UNDEFINED
  9: 4, // SLONG
  10: 8, // SRATIONAL
};

type Entry = { type: number; count: number; valueOffset: number };
type Ifd = Map<number, Entry>;

/**
 * Locates the TIFF block inside a JPEG's APP1 segment. Returns null for any
 * file that is not a JPEG or carries no EXIF.
 */
function findTiffStart(view: DataView): number | null {
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null; // not SOI

  let pos = 2;
  while (pos + 4 <= view.byteLength) {
    if (view.getUint8(pos) !== 0xff) return null; // desynced from the marker chain
    const marker = view.getUint8(pos + 1);
    // Standalone markers carry no length field.
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      pos += 2;
      continue;
    }
    if (marker === 0xda) return null; // start of scan — metadata is behind us
    const length = view.getUint16(pos + 2);
    if (length < 2) return null;
    if (marker === 0xe1 && pos + 4 + 6 <= view.byteLength) {
      // "Exif\0\0"
      const isExif =
        view.getUint32(pos + 4) === 0x45786966 && view.getUint16(pos + 8) === 0x0000;
      if (isExif) return pos + 10;
    }
    pos += 2 + length;
  }
  return null;
}

function readIfd(view: DataView, tiff: number, offset: number, le: boolean): Ifd {
  const entries: Ifd = new Map();
  const base = tiff + offset;
  if (base + 2 > view.byteLength) return entries;
  const count = view.getUint16(base, le);
  for (let i = 0; i < count; i++) {
    const at = base + 2 + i * 12;
    if (at + 12 > view.byteLength) break;
    entries.set(view.getUint16(at, le), {
      type: view.getUint16(at + 2, le),
      count: view.getUint32(at + 4, le),
      valueOffset: at + 8,
    });
  }
  return entries;
}

/** Where an entry's payload lives — inline in the entry, or out at an offset. */
function dataStart(view: DataView, tiff: number, entry: Entry, le: boolean): number | null {
  const size = (TYPE_BYTE_SIZE[entry.type] ?? 0) * entry.count;
  if (size === 0) return null;
  if (size <= 4) return entry.valueOffset;
  const start = tiff + view.getUint32(entry.valueOffset, le);
  return start + size <= view.byteLength ? start : null;
}

function readAscii(view: DataView, tiff: number, entry: Entry, le: boolean): string | null {
  if (entry.type !== 2) return null;
  const start = dataStart(view, tiff, entry, le);
  if (start === null) return null;
  let out = "";
  for (let i = 0; i < entry.count; i++) {
    const c = view.getUint8(start + i);
    if (c === 0) break;
    out += String.fromCharCode(c);
  }
  return out;
}

/** Reads `count` RATIONALs as numbers. Returns null on a malformed entry. */
function readRationals(
  view: DataView,
  tiff: number,
  entry: Entry,
  le: boolean,
  count: number,
): number[] | null {
  if (entry.type !== 5 || entry.count < count) return null;
  const start = dataStart(view, tiff, entry, le);
  if (start === null) return null;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const num = view.getUint32(start + i * 8, le);
    const den = view.getUint32(start + i * 8 + 4, le);
    if (den === 0) return null;
    out.push(num / den);
  }
  return out;
}

function readPointer(view: DataView, tiff: number, entry: Entry | undefined, le: boolean): number | null {
  if (!entry || (entry.type !== 4 && entry.type !== 3)) return null;
  return entry.type === 4 ? view.getUint32(entry.valueOffset, le) : view.getUint16(entry.valueOffset, le);
}

/** Degrees/minutes/seconds plus a hemisphere letter → signed decimal degrees. */
function toDecimal(dms: number[], ref: string | null): number | null {
  const [deg, min, sec] = dms;
  const value = deg + min / 60 + sec / 3600;
  if (!Number.isFinite(value)) return null;
  const hemisphere = (ref ?? "").trim().toUpperCase();
  if (hemisphere === "S" || hemisphere === "W") return -value;
  return value;
}

/** "2026:08:08 18:14:18" + "+01:00" → epoch ms. */
function parseExifDateTime(dateTime: string, offset: string | null): number | null {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(dateTime.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const zone = /^[+-]\d{2}:\d{2}$/.test((offset ?? "").trim()) ? offset!.trim() : null;
  if (!zone) return null;
  const ms = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}${zone}`);
  return Number.isNaN(ms) ? null : ms;
}

/** GPSDateStamp + GPSTimeStamp are always UTC, so they need no offset tag. */
function parseGpsDateTime(date: string, time: number[]): number | null {
  const m = /^(\d{4}):(\d{2}):(\d{2})/.exec(date.trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const [h, mi, s] = time;
  if (![h, mi, s].every((n) => Number.isFinite(n))) return null;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Math.trunc(h), Math.trunc(mi), Math.trunc(s));
  return Number.isNaN(ms) ? null : ms;
}

export function readExif(buffer: ArrayBuffer): ExifData {
  const empty: ExifData = {};
  let view: DataView;
  try {
    view = new DataView(buffer);
  } catch {
    return empty;
  }

  const tiff = findTiffStart(view);
  if (tiff === null || tiff + 8 > view.byteLength) return empty;

  const byteOrder = view.getUint16(tiff);
  if (byteOrder !== 0x4949 && byteOrder !== 0x4d4d) return empty;
  const le = byteOrder === 0x4949;
  if (view.getUint16(tiff + 2, le) !== 0x002a) return empty;

  // A truncated or hostile file should yield no metadata, never an exception.
  try {
    const ifd0 = readIfd(view, tiff, view.getUint32(tiff + 4, le), le);
    const result: ExifData = {};

    const gpsOffset = readPointer(view, tiff, ifd0.get(TAG_GPS_IFD), le);
    let gpsDateTime: { date: string | null; time: number[] | null } = { date: null, time: null };
    if (gpsOffset !== null) {
      const gps = readIfd(view, tiff, gpsOffset, le);
      const latEntry = gps.get(TAG_GPS_LAT);
      const lngEntry = gps.get(TAG_GPS_LNG);
      const lat = latEntry && readRationals(view, tiff, latEntry, le, 3);
      const lng = lngEntry && readRationals(view, tiff, lngEntry, le, 3);
      if (lat && lng) {
        const latRefEntry = gps.get(TAG_GPS_LAT_REF);
        const lngRefEntry = gps.get(TAG_GPS_LNG_REF);
        const decLat = toDecimal(lat, latRefEntry ? readAscii(view, tiff, latRefEntry, le) : null);
        const decLng = toDecimal(lng, lngRefEntry ? readAscii(view, tiff, lngRefEntry, le) : null);
        // A 0/0 fix is what a camera writes when it never got a lock.
        const plausible =
          decLat !== null &&
          decLng !== null &&
          Math.abs(decLat) <= 90 &&
          Math.abs(decLng) <= 180 &&
          !(decLat === 0 && decLng === 0);
        if (plausible) {
          result.lat = decLat!;
          result.lng = decLng!;
        }
      }
      const dateEntry = gps.get(TAG_GPS_DATE);
      const timeEntry = gps.get(TAG_GPS_TIME);
      gpsDateTime = {
        date: dateEntry ? readAscii(view, tiff, dateEntry, le) : null,
        time: timeEntry ? readRationals(view, tiff, timeEntry, le, 3) : null,
      };
    }

    if (gpsDateTime.date && gpsDateTime.time) {
      const ms = parseGpsDateTime(gpsDateTime.date, gpsDateTime.time);
      if (ms !== null) result.takenAtMs = ms;
    }

    if (result.takenAtMs === undefined) {
      const exifOffset = readPointer(view, tiff, ifd0.get(TAG_EXIF_IFD), le);
      if (exifOffset !== null) {
        const exif = readIfd(view, tiff, exifOffset, le);
        const dtEntry = exif.get(TAG_DATETIME_ORIGINAL);
        const offEntry = exif.get(TAG_OFFSET_TIME_ORIGINAL);
        const dt = dtEntry ? readAscii(view, tiff, dtEntry, le) : null;
        const off = offEntry ? readAscii(view, tiff, offEntry, le) : null;
        if (dt) {
          const ms = parseExifDateTime(dt, off);
          if (ms !== null) result.takenAtMs = ms;
        }
      }
    }

    return result;
  } catch {
    return empty;
  }
}
