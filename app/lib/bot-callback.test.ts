import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Update } from "grammy/types";

/**
 * The inline keyboard behind `/manage`, driven through the real bot.
 *
 * A tapped button puts a "Loading…" bar over the whole chat until the bot
 * answers the callback query, and Telegram eventually gives up rather than
 * saying why. That failure is invisible from the outside — no error message,
 * no reply, nothing in the chat — so it needs a test that watches the API calls
 * the bot makes rather than the messages a person would see.
 *
 * The rule this pins down: a tap is acknowledged *before* any of the work, and
 * on every path out, so nothing the database or Telegram does afterwards can
 * leave the bar running.
 */

process.env.TELEGRAM_BOT_TOKEN = "1:TEST";
process.env.TELEGRAM_WEBHOOK_SECRET = "secret";
process.env.TELEGRAM_OWNER_ID = "42";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "service-key";
process.env.CRON_SECRET = "cron";

const CHAT_ID = -100123;

/** What each table answers with. Tests swap entries to set a scene. */
let rows: Record<string, unknown>;
/** Which table, if any, refuses to answer at all. */
let deadTable: string | null = null;

vi.mock("./supabase.server", () => {
  // A chainable stand-in for the query builder: every method returns itself, so
  // the shape of the call chain does not matter, only what it settles to.
  const chain = (table: string): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop !== "then") return () => chain(table);
          return (onOk: unknown, onErr: unknown) =>
            (deadTable === table
              ? Promise.reject(new Error("connection refused"))
              : Promise.resolve({ data: rows[table] ?? null, error: null, count: 0 })
            ).then(onOk as never, onErr as never);
        },
      },
    );

  return {
    supabase: () => ({
      from: (table: string) => chain(table),
      storage: { from: () => ({ remove: async () => ({}) }) },
    }),
  };
});

function callbackUpdate(data: string): Update {
  return {
    update_id: 1,
    callback_query: {
      id: "cb-1",
      from: { id: 42, is_bot: false, first_name: "Leonard" },
      chat_instance: "1",
      data,
      message: {
        message_id: 7,
        date: Math.floor(Date.now() / 1000),
        chat: { id: CHAT_ID, type: "supergroup", title: "TrackTale" },
      },
    },
  } as unknown as Update;
}

/** Runs one update through a real bot and records the API calls it makes. */
async function runCallback(data: string): Promise<string[]> {
  const { createBot } = await import("./bot.server");
  const bot = createBot();
  const calls: string[] = [];

  bot.api.config.use(async (_prev, method) => {
    calls.push(method);
    return { ok: true, result: true } as never;
  });
  // Set by hand so the bot skips the getMe call it would otherwise make on
  // init. Cast rather than spelled out: Telegram keeps adding capability flags
  // to this, and none of them are what is under test here.
  bot.botInfo = {
    id: 1,
    is_bot: true,
    first_name: "TrackTale",
    username: "tracktale_bot",
  } as unknown as typeof bot.botInfo;

  await bot.handleUpdate(callbackUpdate(data));
  return calls;
}

describe("the /manage keyboard", () => {
  beforeEach(() => {
    vi.resetModules();
    deadTable = null;
    // Enough for authorize() to let the tap through, and for the day screen to
    // find a trip and an (empty) day behind it.
    rows = {
      users: { telegram_id: 42, display_name: "Leonard", is_owner: true },
      chats: { chat_id: CHAT_ID, type: "supergroup", title: "TrackTale", active_trip_id: "trip-1" },
      trips: { id: "trip-1", name: "HochlandKinder", start_date: "2026-07-25", end_date: null },
      days: {
        id: "day-1",
        date: "2026-07-25",
        notes: [],
        media: [],
        track_segments: [],
        comments: [],
      },
    };
  });

  it("answers the tap before doing any work", async () => {
    const calls = await runCallback("mg:d:1:0");
    // Not just "somewhere in the list" — first, ahead of the edit it triggers.
    expect(calls[0]).toBe("answerCallbackQuery");
    expect(calls).toContain("editMessageText");
  });

  it("still answers when the database fails on the way to the screen", async () => {
    // The regression this exists for. A throw between the tap and the answer
    // used to leave the chat spinning, with nothing said and nothing to go on.
    deadTable = "days";
    const calls = await runCallback("mg:d:1:0");

    expect(calls[0]).toBe("answerCallbackQuery");
    // And it says so out loud, rather than only into a log nobody is reading.
    expect(calls).toContain("sendMessage");
  });

  it("still answers when the database fails before the sender is even known", async () => {
    // Authorising is itself a database call, and it happens in middleware —
    // outside every try/catch the handler has.
    deadTable = "users";
    const calls = await runCallback("mg:d:1:0");

    expect(calls).toEqual(["answerCallbackQuery"]);
  });

  it("answers a button it cannot read", async () => {
    const calls = await runCallback("mg:this-is-not-a-screen");
    expect(calls[0]).toBe("answerCallbackQuery");
    expect(calls).toContain("sendMessage");
  });

  it("answers a tap from a chat it does not serve", async () => {
    // authorize() deliberately stays silent here; the tap must still be
    // acknowledged, or the bar runs forever for whoever pressed it.
    rows = {};
    const calls = await runCallback("mg:d:1:0");

    expect(calls).toEqual(["answerCallbackQuery"]);
  });

  it("says so rather than going quiet when the trip has been switched away", async () => {
    rows.chats = { chat_id: CHAT_ID, type: "supergroup", title: "TrackTale", active_trip_id: null };
    const calls = await runCallback("mg:d:1:0");

    expect(calls[0]).toBe("answerCallbackQuery");
    expect(calls).toContain("sendMessage");
  });
});
