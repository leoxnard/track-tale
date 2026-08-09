import { describe, expect, it } from "vitest";
import { readExif } from "./exif";

// --- Minimal EXIF-in-JPEG writer, so the tests exercise real byte layouts ---

type TagInput = { tag: number; type: number; count: number; payload: Uint8Array };

function u16(value: number, le: boolean): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, value, le);
  return b;
}

function u32(value: number, le: boolean): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, value, le);
  return b;
}

function rationals(pairs: [number, number][], le: boolean): Uint8Array {
  const b = new Uint8Array(pairs.length * 8);
  const v = new DataView(b.buffer);
  pairs.forEach(([num, den], i) => {
    v.setUint32(i * 8, num, le);
    v.setUint32(i * 8 + 4, den, le);
  });
  return b;
}

function ascii(text: string): Uint8Array {
  const b = new Uint8Array(text.length + 1);
  for (let i = 0; i < text.length; i++) b[i] = text.charCodeAt(i);
  return b;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const ifdSize = (n: number) => 2 + n * 12 + 4;

/** Serialises one IFD, pushing anything over 4 bytes into the shared data area. */
function encodeIfd(tags: TagInput[], dataOffset: number, le: boolean) {
  const sorted = [...tags].sort((a, b) => a.tag - b.tag);
  const data: Uint8Array[] = [];
  let cursor = dataOffset;
  const entries = sorted.map((t) => {
    let valueField: Uint8Array;
    if (t.payload.length <= 4) {
      valueField = new Uint8Array(4);
      valueField.set(t.payload, 0);
    } else {
      valueField = u32(cursor, le);
      data.push(t.payload);
      cursor += t.payload.length;
    }
    return concat([u16(t.tag, le), u16(t.type, le), u32(t.count, le), valueField]);
  });
  return {
    ifd: concat([u16(sorted.length, le), ...entries, u32(0, le)]),
    data: concat(data),
    nextDataOffset: cursor,
  };
}

interface ExifFixture {
  gps?: TagInput[];
  exif?: TagInput[];
  le?: boolean;
}

/** Builds a TIFF block with IFD0 pointing at optional GPS and Exif sub-IFDs. */
function buildTiff({ gps, exif, le = true }: ExifFixture): Uint8Array {
  const ifd0Tags: TagInput[] = [];
  const ifd0Start = 8;
  const ifd0Count = (gps ? 1 : 0) + (exif ? 1 : 0);
  const gpsStart = ifd0Start + ifdSize(ifd0Count);
  const exifStart = gpsStart + (gps ? ifdSize(gps.length) : 0);
  const dataStart = exifStart + (exif ? ifdSize(exif.length) : 0);

  if (exif) ifd0Tags.push({ tag: 0x8769, type: 4, count: 1, payload: u32(exifStart, le) });
  if (gps) ifd0Tags.push({ tag: 0x8825, type: 4, count: 1, payload: u32(gpsStart, le) });

  // Sub-IFD payloads share one data area, so lay them out in sequence.
  const gpsEncoded = gps ? encodeIfd(gps, dataStart, le) : null;
  const exifEncoded = exif
    ? encodeIfd(exif, gpsEncoded?.nextDataOffset ?? dataStart, le)
    : null;
  const ifd0Encoded = encodeIfd(ifd0Tags, exifEncoded?.nextDataOffset ?? dataStart, le);

  return concat([
    le ? new Uint8Array([0x49, 0x49]) : new Uint8Array([0x4d, 0x4d]),
    u16(0x002a, le),
    u32(ifd0Start, le),
    ifd0Encoded.ifd,
    gpsEncoded?.ifd ?? new Uint8Array(),
    exifEncoded?.ifd ?? new Uint8Array(),
    gpsEncoded?.data ?? new Uint8Array(),
    exifEncoded?.data ?? new Uint8Array(),
    ifd0Encoded.data,
  ]);
}

function buildJpeg(fixture: ExifFixture): ArrayBuffer {
  const tiff = buildTiff(fixture);
  const app1Body = concat([ascii("Exif"), new Uint8Array([0x00]), tiff]);
  const jpeg = concat([
    new Uint8Array([0xff, 0xd8]), // SOI
    new Uint8Array([0xff, 0xe1]),
    u16(app1Body.length + 2, false), // segment length is always big-endian
    app1Body,
    new Uint8Array([0xff, 0xda, 0x00, 0x02]), // SOS, then "image data"
    new Uint8Array([0x11, 0x22, 0x33]),
  ]);
  return jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength) as ArrayBuffer;
}

// Newcastle-ish: 54° 58' 45.6" N, 1° 36' 43.2" W
const latTags = (le: boolean, ref = "N"): TagInput[] => [
  { tag: 0x0001, type: 2, count: ref.length + 1, payload: ascii(ref) },
  {
    tag: 0x0002,
    type: 5,
    count: 3,
    payload: rationals(
      [
        [54, 1],
        [58, 1],
        [456, 10],
      ],
      le,
    ),
  },
];

const lngTags = (le: boolean, ref = "W"): TagInput[] => [
  { tag: 0x0003, type: 2, count: ref.length + 1, payload: ascii(ref) },
  {
    tag: 0x0004,
    type: 5,
    count: 3,
    payload: rationals(
      [
        [1, 1],
        [36, 1],
        [432, 10],
      ],
      le,
    ),
  },
];

describe("readExif", () => {
  it("reads GPS coordinates as signed decimal degrees", () => {
    const exif = readExif(buildJpeg({ gps: [...latTags(true), ...lngTags(true)] }));
    expect(exif.lat).toBeCloseTo(54.9793, 4);
    expect(exif.lng).toBeCloseTo(-1.612, 4);
  });

  it("handles big-endian files", () => {
    const exif = readExif(buildJpeg({ le: false, gps: [...latTags(false), ...lngTags(false)] }));
    expect(exif.lat).toBeCloseTo(54.9793, 4);
    expect(exif.lng).toBeCloseTo(-1.612, 4);
  });

  it("honours the southern and eastern hemispheres", () => {
    const exif = readExif(
      buildJpeg({ gps: [...latTags(true, "S"), ...lngTags(true, "E")] }),
    );
    expect(exif.lat).toBeCloseTo(-54.9793, 4);
    expect(exif.lng).toBeCloseTo(1.612, 4);
  });

  it("prefers the GPS timestamp, which is already UTC", () => {
    const exif = readExif(
      buildJpeg({
        gps: [
          ...latTags(true),
          ...lngTags(true),
          { tag: 0x001d, type: 2, count: 11, payload: ascii("2026:08:08") },
          {
            tag: 0x0007,
            type: 5,
            count: 3,
            payload: rationals(
              [
                [18, 1],
                [14, 1],
                [18, 1],
              ],
              true,
            ),
          },
        ],
        exif: [
          { tag: 0x9003, type: 2, count: 20, payload: ascii("2026:08:08 19:14:18") },
          { tag: 0x9011, type: 2, count: 7, payload: ascii("+01:00") },
        ],
      }),
    );
    expect(exif.takenAtMs).toBe(Date.parse("2026-08-08T18:14:18Z"));
  });

  it("falls back to DateTimeOriginal plus its UTC offset", () => {
    const exif = readExif(
      buildJpeg({
        exif: [
          { tag: 0x9003, type: 2, count: 20, payload: ascii("2026:08:08 19:14:18") },
          { tag: 0x9011, type: 2, count: 7, payload: ascii("+01:00") },
        ],
      }),
    );
    expect(exif.takenAtMs).toBe(Date.parse("2026-08-08T18:14:18Z"));
  });

  it("ignores a capture time with no resolvable time zone", () => {
    const exif = readExif(
      buildJpeg({
        exif: [{ tag: 0x9003, type: 2, count: 20, payload: ascii("2026:08:08 19:14:18") }],
      }),
    );
    expect(exif.takenAtMs).toBeUndefined();
  });

  it("rejects the null-island fix a camera writes without a lock", () => {
    const zero = rationals(
      [
        [0, 1],
        [0, 1],
        [0, 1],
      ],
      true,
    );
    const exif = readExif(
      buildJpeg({
        gps: [
          { tag: 0x0001, type: 2, count: 2, payload: ascii("N") },
          { tag: 0x0002, type: 5, count: 3, payload: zero },
          { tag: 0x0003, type: 2, count: 2, payload: ascii("E") },
          { tag: 0x0004, type: 5, count: 3, payload: zero },
        ],
      }),
    );
    expect(exif.lat).toBeUndefined();
    expect(exif.lng).toBeUndefined();
  });

  it("returns nothing for a photo with no GPS tags", () => {
    const exif = readExif(
      buildJpeg({
        exif: [{ tag: 0x9003, type: 2, count: 20, payload: ascii("2026:08:08 19:14:18") }],
      }),
    );
    expect(exif.lat).toBeUndefined();
    expect(exif.lng).toBeUndefined();
  });

  it("survives files that are not JPEGs at all", () => {
    expect(readExif(new Uint8Array([1, 2, 3, 4]).buffer as ArrayBuffer)).toEqual({});
    expect(readExif(new ArrayBuffer(0))).toEqual({});
  });

  it("survives a JPEG whose EXIF block is truncated", () => {
    const full = new Uint8Array(buildJpeg({ gps: [...latTags(true), ...lngTags(true)] }));
    const cut = full.slice(0, full.length - 30);
    expect(() => readExif(cut.buffer as ArrayBuffer)).not.toThrow();
  });

  it("skips a JPEG that carries no APP1 segment", () => {
    const jpeg = concat([
      new Uint8Array([0xff, 0xd8]),
      new Uint8Array([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]), // JFIF-ish APP0
      new Uint8Array([0xff, 0xda, 0x00, 0x02]),
    ]);
    expect(readExif(jpeg.buffer as ArrayBuffer)).toEqual({});
  });
});
