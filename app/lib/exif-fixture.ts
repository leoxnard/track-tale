/**
 * A minimal EXIF-in-JPEG writer, used only by tests.
 *
 * The point is to exercise real byte layouts rather than a mock: sharp's
 * `withExif` quietly drops a GPS block, and no fixture library ships the exact
 * shape a phone writes. So the tests build the TIFF structure themselves.
 */

export interface TagInput {
  tag: number;
  type: number;
  count: number;
  payload: Uint8Array;
}

export function u16(value: number, le: boolean): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, value, le);
  return b;
}

export function u32(value: number, le: boolean): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, value, le);
  return b;
}

export function rationals(pairs: [number, number][], le: boolean): Uint8Array {
  const b = new Uint8Array(pairs.length * 8);
  const v = new DataView(b.buffer);
  pairs.forEach(([num, den], i) => {
    v.setUint32(i * 8, num, le);
    v.setUint32(i * 8 + 4, den, le);
  });
  return b;
}

export function ascii(text: string): Uint8Array {
  const b = new Uint8Array(text.length + 1);
  for (let i = 0; i < text.length; i++) b[i] = text.charCodeAt(i);
  return b;
}

export function concat(parts: Uint8Array[]): Uint8Array {
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

export interface ExifFixture {
  gps?: TagInput[];
  exif?: TagInput[];
  le?: boolean;
}

/** A TIFF block with IFD0 pointing at optional GPS and Exif sub-IFDs. */
export function buildTiff({ gps, exif, le = true }: ExifFixture): Uint8Array {
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
  const exifEncoded = exif ? encodeIfd(exif, gpsEncoded?.nextDataOffset ?? dataStart, le) : null;
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

/** The APP1 segment, marker and length included, ready to splice into a JPEG. */
export function exifApp1(fixture: ExifFixture): Uint8Array {
  const body = concat([ascii("Exif"), new Uint8Array([0x00]), buildTiff(fixture)]);
  return concat([
    new Uint8Array([0xff, 0xe1]),
    u16(body.length + 2, false), // segment length is always big-endian
    body,
  ]);
}

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

/**
 * A JPEG shell with the metadata but no real picture — enough to test the
 * reader, not enough to decode.
 */
export function buildJpeg(fixture: ExifFixture): ArrayBuffer {
  return toArrayBuffer(
    concat([
      new Uint8Array([0xff, 0xd8]), // SOI
      exifApp1(fixture),
      new Uint8Array([0xff, 0xda, 0x00, 0x02]), // SOS, then "image data"
      new Uint8Array([0x11, 0x22, 0x33]),
    ]),
  );
}

/**
 * Puts the fixture's EXIF into a real, decodable JPEG, for the tests that have
 * to hand the bytes to an actual image pipeline.
 */
export function withExifSegment(jpeg: Uint8Array, fixture: ExifFixture): ArrayBuffer {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error("not a JPEG");
  return toArrayBuffer(concat([jpeg.slice(0, 2), exifApp1(fixture), jpeg.slice(2)]));
}

/** Newcastle-ish: 54° 58' 45.6" N, 1° 36' 43.2" W */
export const newcastleGps = (le = true, latRef = "N", lngRef = "W"): TagInput[] => [
  { tag: 0x0001, type: 2, count: latRef.length + 1, payload: ascii(latRef) },
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
  { tag: 0x0003, type: 2, count: lngRef.length + 1, payload: ascii(lngRef) },
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
