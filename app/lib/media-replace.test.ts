import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Swapping the picture behind a photo, in the order that keeps the photo
 * intact whichever step fails.
 *
 * There are three writes here — upload the new files, point the row at them,
 * delete the old ones — and every wrong ordering of them has a failure that
 * loses a picture for good. That is the whole reason this logic sits away from
 * Telegram in its own module: it can be tested without a network, and it needs
 * to be.
 */

process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "service-key";

/** The media row the swap reads, or null for one that has been deleted. */
let mediaRow: {
  storage_path: string;
  thumb_path: string | null;
  caption: string | null;
} | null;
/** What the UPDATE settles to: rows touched, or an error. */
let updateResult: { data: { id: string }[] | null; error: unknown };
let uploadError: unknown = null;

/** Every write, in the order it happened — the property under test. */
let events: string[] = [];
let updatePayload: Record<string, unknown> | undefined;

vi.mock("./supabase.server", () => ({
  supabase: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: mediaRow, error: null }) }),
      }),
      update: (payload: Record<string, unknown>) => {
        updatePayload = payload;
        return {
          eq: () => ({
            select: async () => {
              events.push("update");
              return updateResult;
            },
          }),
        };
      },
      delete: () => ({ eq: async () => ({ error: null }) }),
      upsert: async () => ({ error: null }),
      __table: table,
    }),
    storage: {
      from: () => ({
        upload: async (path: string) => {
          events.push(`upload ${path}`);
          return { error: uploadError };
        },
        remove: async (paths: string[]) => {
          events.push(`remove ${paths.join(",")}`);
          return { error: null };
        },
      }),
    },
  }),
}));

const bytes = () => new ArrayBuffer(8);

async function swap(caption: string | null = null, withThumb = true) {
  const { replacePhoto } = await import("./media-replace.server");
  return replacePhoto("media-1", {
    full: bytes(),
    thumb: withThumb ? bytes() : null,
    caption,
  });
}

describe("replacing the picture behind a photo", () => {
  beforeEach(() => {
    vi.resetModules();
    events = [];
    updatePayload = undefined;
    uploadError = null;
    updateResult = { data: [{ id: "media-1" }], error: null };
    mediaRow = {
      storage_path: "trip-1/day-3/OLDoldOL.jpg",
      thumb_path: "trip-1/day-3/OLDoldOL-thumb.jpg",
      caption: "Sunrise over the pass",
    };
  });

  it("keeps the caption when the new picture doesn't carry one", async () => {
    // The point of replacing rather than re-sending: a filtered copy of a photo
    // is the same photo, and re-typing the caption is exactly the work this is
    // meant to save.
    await swap(null);
    expect(updatePayload?.caption).toBe("Sunrise over the pass");
  });

  it("takes a caption the new picture does carry", async () => {
    await swap("Sunrise, warmer this time");
    expect(updatePayload?.caption).toBe("Sunrise, warmer this time");
  });

  it("writes to a new name instead of over the old one", async () => {
    // Overwriting the path would be the tidy-looking choice and the wrong one:
    // the family page, Telegram's previews and any CDN in between all cache by
    // URL, so everyone would go on seeing the picture that was just replaced.
    await swap();
    const written = String(updatePayload?.storage_path);
    expect(written).not.toBe("trip-1/day-3/OLDoldOL.jpg");
    // Same day's folder though — that is where the trip and day live.
    expect(written.startsWith("trip-1/day-3/")).toBe(true);
  });

  it("deletes the old files only once the row points somewhere else", async () => {
    await swap();

    const update = events.indexOf("update");
    const removeOld = events.findIndex((e) => e.startsWith("remove") && e.includes("OLDoldOL"));
    expect(events[0]).toMatch(/^upload /);
    expect(update).toBeGreaterThan(0);
    // The ordering that matters: reversed, a failed update would leave the row
    // pointing at files that had already been deleted — a photo showing nothing
    // at all, and no way back.
    expect(removeOld).toBeGreaterThan(update);
  });

  it("takes the new files back out again when the row has gone", async () => {
    // Deleted between the read and the write, from /manage or another chat.
    updateResult = { data: [], error: null };

    expect(await swap()).toBe(false);
    const cleanup = events.find((e) => e.startsWith("remove"));
    expect(cleanup).toBeDefined();
    // What it cleans up is what it just uploaded, not the surviving originals.
    expect(cleanup).not.toContain("OLDoldOL");
  });

  it("strands nothing in the bucket when the update fails outright", async () => {
    updateResult = { data: null, error: new Error("connection refused") };

    await expect(swap()).rejects.toThrow("connection refused");
    expect(events.some((e) => e.startsWith("remove"))).toBe(true);
    // And the originals are still the ones the row names.
    expect(events.find((e) => e.startsWith("remove"))).not.toContain("OLDoldOL");
  });

  it("says so rather than uploading into nowhere when the photo is already gone", async () => {
    mediaRow = null;

    expect(await swap()).toBe(false);
    expect(events).toEqual([]);
  });

  it("survives Telegram offering no separate thumbnail", async () => {
    await swap(null, false);
    expect(updatePayload?.thumb_path).toBeNull();
    expect(events.filter((e) => e.startsWith("upload"))).toHaveLength(1);
  });
});
