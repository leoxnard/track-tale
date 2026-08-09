import { describe, expect, it } from "vitest";
import { readExif } from "./exif";
import { ascii, buildJpeg, concat, newcastleGps, rationals } from "./exif-fixture";

const latTags = (le: boolean, ref = "N") => newcastleGps(le, ref).slice(0, 2);
const lngTags = (le: boolean, ref = "W") => newcastleGps(le, "N", ref).slice(2);

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
