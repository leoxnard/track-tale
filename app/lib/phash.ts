import sharp from "sharp";

/**
 * A fingerprint of what a picture *looks* like, so an edited export can be
 * recognised as the same shot as the phone-quality version already on the trip.
 *
 * This is a difference hash: shrink to 9×8 greyscale, then record whether each
 * pixel is brighter than the one to its right. Only the direction of each step
 * survives, which is exactly what a Lightroom edit leaves alone — exposure,
 * white balance and contrast move every pixel but rarely flip the gradient
 * between neighbours. Resizing and re-compression drop out too, since the
 * comparison happens at 9×8.
 *
 * What it does not survive is a crop or a straighten, which shift the grid.
 * Those come back as "no match", and the photo is filed as a new one — the
 * failure mode is an extra picture, never a wrong swap.
 */

const WIDTH = 9;
const HEIGHT = 8;

/** 64 bits as 16 hex characters. */
export async function perceptualHash(image: ArrayBuffer | Uint8Array): Promise<string> {
  const { data } = await sharp(image instanceof Uint8Array ? image : new Uint8Array(image))
    // The stored copy has its orientation baked into the pixels while an
    // original still carries it as a tag. Without this they hash differently.
    .rotate()
    .greyscale()
    .resize(WIDTH, HEIGHT, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  let hex = "";
  let nibble = 0;
  let bitsInNibble = 0;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH - 1; x++) {
      const here = data[y * WIDTH + x];
      const right = data[y * WIDTH + x + 1];
      nibble = (nibble << 1) | (here > right ? 1 : 0);
      if (++bitsInNibble === 4) {
        hex += nibble.toString(16);
        nibble = 0;
        bitsInNibble = 0;
      }
    }
  }
  return hex;
}

const POPCOUNT = Array.from({ length: 16 }, (_, i) => (i.toString(2).match(/1/g) ?? []).length);

/** How many of the 64 bits differ. 0 is identical, ~32 is unrelated. */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    distance += POPCOUNT[(parseInt(a[i], 16) ^ parseInt(b[i], 16)) & 0xf];
  }
  return distance;
}

/**
 * Close enough to be the same photograph. Set well below the ~32 bits two
 * unrelated pictures differ by, because the cost of a false match is
 * overwriting the wrong photo.
 */
export const TWIN_MAX_DISTANCE = 12;

/**
 * How far clear of the runner-up the winner has to be. Two frames of the same
 * view seconds apart are genuinely similar, and picking between them on a bit
 * or two is guessing — better to decline and let the photo be filed as new.
 */
export const TWIN_MIN_MARGIN = 6;

export interface HashedPhoto {
  id: string;
  hash: string;
}

export interface TwinMatch {
  id: string;
  distance: number;
  /** Distance to the next-best candidate, or Infinity when there was only one. */
  runnerUp: number;
}

/**
 * The one photo that is confidently the same picture, or null when nothing is
 * close enough or two candidates are too alike to choose between.
 */
export function findTwin(hash: string, candidates: HashedPhoto[]): TwinMatch | null {
  let best: HashedPhoto | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  let runnerUp = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const distance = hammingDistance(hash, candidate.hash);
    if (distance < bestDistance) {
      runnerUp = bestDistance;
      bestDistance = distance;
      best = candidate;
    } else if (distance < runnerUp) {
      runnerUp = distance;
    }
  }

  if (!best || bestDistance > TWIN_MAX_DISTANCE) return null;
  if (runnerUp - bestDistance < TWIN_MIN_MARGIN) return null;
  return { id: best.id, distance: bestDistance, runnerUp };
}
