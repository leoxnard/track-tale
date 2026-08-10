import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The guestbook is the only place where somebody who is not a traveller writes
 * into the database, and every message it accepts rings a phone on the road.
 * That makes its limits worth pinning down: what it rejects, what it lets
 * through, and what it counts when deciding.
 */

process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "service-key";
process.env.TELEGRAM_BOT_TOKEN = "123:abc";

/** The trip the slug resolves to, or null for a link that means nothing. */
let trip: { id: string; name: string; chat_id: number } | null;
/** Every day of the trip, which is also what the rate window is counted over. */
let days: { id: string; day_number: number }[];
/** Comments already posted inside the rate window, across the whole trip. */
let recentComments: number;
let insertError: unknown;

let countedDayIds: string[] | undefined;
let inserted: Record<string, unknown> | undefined;
let relayed: string[] = [];
let relayFails = false;

vi.mock("./supabase.server", () => ({
  supabase: () => ({
    from: (table: string) => {
      if (table === "trips") {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: trip }) }) }),
        };
      }
      if (table === "days") {
        return { select: () => ({ eq: async () => ({ data: days }) }) };
      }
      if (table === "comments") {
        return {
          select: () => ({
            in: (_col: string, ids: string[]) => {
              countedDayIds = ids;
              return { gt: async () => ({ count: recentComments }) };
            },
          }),
          insert: (payload: Record<string, unknown>) => {
            inserted = payload;
            return {
              select: () => ({
                single: async () => ({
                  data: insertError ? null : { id: "comment-1" },
                  error: insertError,
                }),
              }),
            };
          },
        };
      }
      return { insert: async () => ({ error: null }) };
    },
  }),
}));

vi.mock("grammy", () => ({
  Bot: class {
    api = {
      sendMessage: async (_chatId: number, text: string) => {
        if (relayFails) throw new Error("telegram is down");
        relayed.push(text);
        return { message_id: 42 };
      },
    };
  },
}));

const { postComment } = await import("./comments.server");

const post = (over: Partial<Parameters<typeof postComment>[0]> = {}) =>
  postComment({ slug: "abc", dayNumber: 1, authorName: "Oma", text: "Schöne Tour!", ...over });

beforeEach(() => {
  trip = { id: "trip-1", name: "Alpen", chat_id: 555 };
  days = [
    { id: "day-1", day_number: 1 },
    { id: "day-2", day_number: 2 },
  ];
  recentComments = 0;
  insertError = null;
  countedDayIds = undefined;
  inserted = undefined;
  relayed = [];
  relayFails = false;
});

describe("postComment", () => {
  it("saves a message and relays it to the travellers", async () => {
    expect(await post()).toEqual({ ok: true });
    expect(inserted).toMatchObject({ day_id: "day-1", author_name: "Oma", text: "Schöne Tour!" });
    expect(relayed[0]).toContain("Oma");
  });

  it("turns away a message with no name or no text", async () => {
    expect(await post({ authorName: "   " })).toMatchObject({ ok: false });
    expect(await post({ text: "\n " })).toMatchObject({ ok: false });
    expect(inserted).toBeUndefined();
  });

  it("trims a name and a message down to their limits", async () => {
    await post({ authorName: "N".repeat(100), text: "T".repeat(2000) });
    expect((inserted!.author_name as string).length).toBe(40);
    expect((inserted!.text as string).length).toBe(800);
  });

  it("does not resolve a slug that belongs to no trip", async () => {
    trip = null;
    expect(await post()).toMatchObject({ ok: false });
    expect(inserted).toBeUndefined();
  });

  it("does not accept a day the trip does not have", async () => {
    expect(await post({ dayNumber: 9 })).toMatchObject({ ok: false });
    expect(inserted).toBeUndefined();
  });

  it("counts the rate window across the whole trip, not one day", async () => {
    // The hole this closes: per day, the ceiling multiplied by the number of
    // days, so a long trip could be flooded a day at a time.
    await post();
    expect(countedDayIds).toEqual(["day-1", "day-2"]);
  });

  it("stops accepting once the trip has hit the ceiling", async () => {
    recentComments = 10;
    expect(await post()).toMatchObject({ ok: false });
    expect(inserted).toBeUndefined();
  });

  it("still accepts the message that reaches the ceiling", async () => {
    recentComments = 9;
    expect(await post()).toEqual({ ok: true });
  });

  it("keeps a saved message when the relay to Telegram fails", async () => {
    // The visitor did nothing wrong and their message is in the database;
    // failing them here would invite them to send it again.
    relayFails = true;
    expect(await post()).toEqual({ ok: true });
    expect(inserted).toBeDefined();
  });

  it("reports a failed save rather than pretending", async () => {
    insertError = new Error("no");
    expect(await post()).toMatchObject({ ok: false });
    expect(relayed).toEqual([]);
  });
});
