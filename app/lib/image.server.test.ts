import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { compressForWeb, formatBytes, COMPRESS_ABOVE_BYTES } from "./image.server";
import { readExif } from "./exif";
import { newcastleGps, withExifSegment } from "./exif-fixture";

/** A camera-sized photo: enough detail that JPEG can't cheat its way small. */
async function cameraOriginal(width = 6000, height = 4000) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i += 3) {
    pixels[i] = (i * 7) % 256;
    pixels[i + 1] = (i * 13) % 256;
    pixels[i + 2] = (i * 29) % 256;
  }
  const jpeg = await sharp(pixels, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 98 })
    .toBuffer();
  return jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength) as ArrayBuffer;
}

describe("compressForWeb", () => {
  it("turns a camera original into something a page can actually load", async () => {
    const original = await cameraOriginal();
    expect(original.byteLength).toBeGreaterThan(COMPRESS_ABOVE_BYTES);

    const web = await compressForWeb(original);
    const display = await sharp(web.display).metadata();
    const thumb = await sharp(web.thumb).metadata();

    expect(Math.max(display.width!, display.height!)).toBe(2048);
    expect(Math.max(thumb.width!, thumb.height!)).toBe(480);
    expect(web.display.byteLength).toBeLessThan(original.byteLength / 4);
    expect(web.thumb.byteLength).toBeLessThan(web.display.byteLength);
    expect(web.displayBytes).toBe(web.display.byteLength);
  }, 30_000);

  it("never enlarges a picture that is already small", async () => {
    const small = await sharp({
      create: { width: 800, height: 600, channels: 3, background: "#3a6ea5" },
    })
      .jpeg()
      .toBuffer();
    const web = await compressForWeb(
      small.buffer.slice(small.byteOffset, small.byteOffset + small.byteLength) as ArrayBuffer,
    );
    const display = await sharp(web.display).metadata();
    expect(display.width).toBe(800);
    expect(display.height).toBe(600);
  });

  it("bakes in EXIF orientation, since the stored copy carries no EXIF to read", async () => {
    // Orientation 6 means "rotate 90° clockwise to display": a 900×600 file
    // that a viewer is supposed to show as 600×900. A phone held sideways
    // writes exactly this rather than rotating the pixels.
    const rotated = await sharp({
      create: { width: 900, height: 600, channels: 3, background: "#8a6a4a" },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    expect((await sharp(rotated).metadata()).orientation).toBe(6);

    const web = await compressForWeb(
      rotated.buffer.slice(
        rotated.byteOffset,
        rotated.byteOffset + rotated.byteLength,
      ) as ArrayBuffer,
    );
    const display = await sharp(web.display).metadata();
    expect(display.width).toBe(600);
    expect(display.height).toBe(900);
    // Baked in, not merely re-declared: nothing downstream has to honour a tag.
    expect(display.orientation ?? 1).toBe(1);
  });

  it("strips the GPS fix from the copy it hands to the public page", async () => {
    // The co-ordinates are saved to the database on the way in; the picture the
    // family link serves has no business repeating them. sharp's own withExif
    // drops a GPS block, so the fixture splices in a real one.
    const plain = await sharp({
      create: { width: 1200, height: 900, channels: 3, background: "#2f6f4f" },
    })
      .jpeg()
      .toBuffer();
    const original = withExifSegment(plain, { gps: newcastleGps() });

    // Readable before compression — this is what the bot writes to the row.
    expect(readExif(original).lat).toBeCloseTo(54.9793, 3);

    const web = await compressForWeb(original);
    const served = readExif(
      web.display.buffer.slice(
        web.display.byteOffset,
        web.display.byteOffset + web.display.byteLength,
      ) as ArrayBuffer,
    );
    expect(served.lat).toBeUndefined();
    expect(served.lng).toBeUndefined();
  });
});

describe("formatBytes", () => {
  it("reads the way a person would say it", () => {
    expect(formatBytes(8_130_000)).toBe("8.1 MB");
    expect(formatBytes(432_000)).toBe("432 kB");
  });
});
