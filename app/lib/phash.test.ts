import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { findTwin, hammingDistance, perceptualHash, TWIN_MAX_DISTANCE } from "./phash";

/**
 * A stand-in for a photograph: a horizon, a sun, some ground texture. Enough
 * structure that a difference hash has something to hold on to.
 */
async function scene(seed: number, width = 1600, height = 1200) {
  const px = Buffer.alloc(width * height * 3);
  const sunX = width * 0.3 + seed * 90;
  const sunY = height * 0.25;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const sky = y < height * 0.55;
      const sun = Math.hypot(x - sunX, y - sunY) < width * 0.08;
      const grain = ((x * 2654435761 + y * (40503 + seed * 7)) % 48) - 24;
      if (sun) {
        px[i] = 255;
        px[i + 1] = 245;
        px[i + 2] = 200;
      } else if (sky) {
        px[i] = 110 + y / 20;
        px[i + 1] = 150 + y / 25;
        px[i + 2] = 205 - y / 40;
      } else {
        px[i] = Math.max(0, Math.min(255, 80 + grain + seed * 3));
        px[i + 1] = Math.max(0, Math.min(255, 105 + grain));
        px[i + 2] = Math.max(0, Math.min(255, 60 + grain));
      }
    }
  }
  return sharp(px, { raw: { width, height, channels: 3 } });
}

const jpeg = async (img: ReturnType<typeof sharp>, quality = 90) => {
  const b = await img.jpeg({ quality }).toBuffer();
  return new Uint8Array(b);
};

describe("perceptualHash", () => {
  it("is 64 bits of hex", async () => {
    const hash = await perceptualHash(await jpeg(await scene(0)));
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is unchanged by the compression the bot applies on the way in", async () => {
    const original = await jpeg(await scene(0), 98);
    const stored = await jpeg((await scene(0)).resize(2048), 80);
    expect(hammingDistance(await perceptualHash(original), await perceptualHash(stored))).toBe(0);
  });

  it("survives the tone and exposure changes an edit makes", async () => {
    // What a Lightroom pass does: lifts exposure, pushes contrast, warms it.
    const shot = await jpeg(await scene(1));
    const edited = await jpeg(
      (await scene(1)).modulate({ brightness: 1.25, saturation: 1.4 }).linear(1.2, -18),
    );
    const distance = hammingDistance(await perceptualHash(shot), await perceptualHash(edited));
    expect(distance).toBeLessThanOrEqual(TWIN_MAX_DISTANCE);
  });

  it("hashes a sideways phone photo the same either way round", async () => {
    // One file declares its rotation in EXIF, the other has it in the pixels —
    // the stored copy is always the second kind.
    const upright = await jpeg((await scene(2, 1200, 900)).rotate(90));
    const tagged = await jpeg((await scene(2, 1200, 900)).withMetadata({ orientation: 6 }));
    expect(hammingDistance(await perceptualHash(upright), await perceptualHash(tagged))).toBe(0);
  });

  it("tells two different pictures apart by a wide margin", async () => {
    const a = await perceptualHash(await jpeg(await scene(0)));
    const b = await perceptualHash(await jpeg(await scene(9)));
    expect(hammingDistance(a, b)).toBeGreaterThan(TWIN_MAX_DISTANCE);
  });
});

describe("hammingDistance", () => {
  it("counts differing bits", () => {
    expect(hammingDistance("0000000000000000", "0000000000000000")).toBe(0);
    expect(hammingDistance("0000000000000001", "0000000000000000")).toBe(1);
    expect(hammingDistance("ffffffffffffffff", "0000000000000000")).toBe(64);
  });

  it("refuses to compare hashes of different lengths", () => {
    expect(hammingDistance("ff", "ffff")).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("findTwin", () => {
  const near = "0000000000000000";

  it("picks the one photo that is clearly the same shot", () => {
    const match = findTwin(near, [
      { id: "same", hash: "0000000000000003" }, // 2 bits off
      { id: "other", hash: "ffffffff00000000" }, // 32 bits off
    ]);
    expect(match?.id).toBe("same");
    expect(match?.distance).toBe(2);
  });

  it("declines when nothing is close", () => {
    expect(findTwin(near, [{ id: "other", hash: "ffffffff00000000" }])).toBeNull();
  });

  it("declines when two candidates are equally plausible", () => {
    // Two frames of the same view, seconds apart. Guessing between them would
    // overwrite the wrong one, so the photo gets filed as new instead.
    expect(
      findTwin(near, [
        { id: "frame-1", hash: "0000000000000003" },
        { id: "frame-2", hash: "0000000000000007" },
      ]),
    ).toBeNull();
  });

  it("matches against a lone candidate with nothing to compare it to", () => {
    expect(findTwin(near, [{ id: "only", hash: "0000000000000001" }])?.id).toBe("only");
  });

  it("has nothing to say about an empty trip", () => {
    expect(findTwin(near, [])).toBeNull();
  });
});
