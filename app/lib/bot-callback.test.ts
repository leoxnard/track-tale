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
      storage: {
        from: () => ({
          remove: async () => ({}),
          upload: async () => ({ error: null }),
          getPublicUrl: (path: string) => ({
            data: { publicUrl: `https://example.supabase.co/storage/${path}` },
          }),
        }),
      },
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

function commandUpdate(text: string): Update {
  return {
    update_id: 2,
    message: {
      message_id: 8,
      date: Math.floor(Date.now() / 1000),
      chat: { id: CHAT_ID, type: "supergroup", title: "TrackTale" },
      from: { id: 42, is_bot: false, first_name: "Leonard" },
      text,
      entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }],
    },
  } as unknown as Update;
}

/** What Telegram answers, per method. Anything unlisted answers `true`. */
let apiResults: Record<string, unknown> = {};
/** Every payload the bot sent, in order, for the assertions that need it. */
let apiPayloads: { method: string; payload: Record<string, unknown> }[] = [];

/** Runs one update through a real bot and records the API calls it makes. */
async function runUpdate(update: Update): Promise<string[]> {
  const { createBot } = await import("./bot.server");
  const bot = createBot();
  const calls: string[] = [];

  bot.api.config.use(async (_prev, method, payload) => {
    calls.push(method);
    apiPayloads.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: apiResults[method] ?? true } as never;
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

  await bot.handleUpdate(update);
  return calls;
}

const runCallback = (data: string) => runUpdate(callbackUpdate(data));

describe("the /manage keyboard", () => {
  beforeEach(() => {
    vi.resetModules();
    deadTable = null;
    apiResults = {};
    apiPayloads = [];
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

  it("answers the /diag self-test without touching a trip or a day", async () => {
    // The point of the button: it says "the tap arrived" even when everything
    // behind it is unreachable, which is how a delivery problem is told apart
    // from a broken screen.
    deadTable = "trips";
    const calls = await runCallback("mg:k");

    expect(calls[0]).toBe("answerCallbackQuery");
    expect(calls).toContain("sendMessage");
  });

  it("says so rather than going quiet when the trip has been switched away", async () => {
    rows.chats = { chat_id: CHAT_ID, type: "supergroup", title: "TrackTale", active_trip_id: null };
    const calls = await runCallback("mg:d:1:0");

    expect(calls[0]).toBe("answerCallbackQuery");
    expect(calls).toContain("sendMessage");
  });
});

/**
 * The screens that replaced a command's syntax with a keyboard. What matters
 * about each is that the tap comes back with something to tap next — a picker
 * that offers the wrong days, or a screen that needs a trip it hasn't got, is
 * the same dead end the buttons exist to remove.
 */
describe("the trip and day pickers", () => {
  beforeEach(() => {
    vi.resetModules();
    deadTable = null;
    apiResults = {};
    apiPayloads = [];
    rows = {
      users: { telegram_id: 42, display_name: "Leonard", is_owner: true },
      chats: { chat_id: CHAT_ID, type: "supergroup", title: "TrackTale", active_trip_id: "trip-1" },
      trips: {
        id: "trip-1",
        name: "HochlandKinder",
        start_date: "2026-07-25",
        end_date: null,
        current_day_number: 2,
        owner_telegram_id: 42,
        reminders_enabled: false,
        share_slug: "abc",
      },
      days: [
        {
          id: "day-1",
          day_number: 1,
          date: "2026-07-25",
          notes: [{ id: "n1" }],
          media: [],
          track_segments: [],
          comments: [],
        },
        {
          id: "day-2",
          day_number: 2,
          date: "2026-07-26",
          notes: [],
          media: [],
          track_segments: [{ id: "t1" }],
          comments: [],
        },
      ],
    };
  });

  const keyboard = (method = "editMessageText") =>
    JSON.stringify(apiPayloads.find((c) => c.method === method)?.payload.reply_markup ?? {});

  it("offers the day after the last one, so a new day can be started from the picker", async () => {
    // The trip has no end date, so there is no last day to list — days 1 and 2
    // exist, and day 3 is the one about to happen.
    await runCallback("mg:dp:0:s");

    expect(keyboard()).toContain("Day 3");
    expect(keyboard()).not.toContain("Day 4");
  });

  it("marks the current day and the ones that already hold something", async () => {
    await runCallback("mg:dp:0:s");

    expect(keyboard()).toContain("✅ Day 2");
    expect(keyboard()).toContain("• Day 1");
  });

  it("switches the day from a tap and comes back with the picker", async () => {
    const calls = await runCallback("mg:sd:3");

    expect(calls[0]).toBe("answerCallbackQuery");
    const text = String(
      apiPayloads.find((c) => c.method === "editMessageText")?.payload.text ?? "",
    );
    expect(text).toContain("is now current");
  });

  it("lists the trips even when the chat has no active one", async () => {
    // The one screen that must not need a trip: it is how you get one back.
    rows.chats = { chat_id: CHAT_ID, type: "supergroup", title: "TrackTale", active_trip_id: null };
    rows.trips = [
      { id: "trip-1", name: "HochlandKinder", start_date: "2026-07-25", end_date: null },
      { id: "trip-2", name: "Alpen", start_date: "2025-06-01", end_date: "2025-06-10", finished_at: "2025-06-10" },
    ];
    const calls = await runCallback("mg:tp");

    expect(calls[0]).toBe("answerCallbackQuery");
    expect(keyboard()).toContain("Alpen");
  });

  it("asks before deleting a trip, and only deletes on the second tap", async () => {
    rows.trips = [{ id: "trip-1", name: "HochlandKinder", start_date: "2026-07-25", end_date: null, owner_telegram_id: 42 }];
    await runCallback("mg:dx:0:trip-1");

    const text = String(
      apiPayloads.find((c) => c.method === "editMessageText")?.payload.text ?? "",
    );
    expect(text).toContain("no undo");
    // The confirming button is the only one that carries the id back.
    expect(keyboard()).toContain("mg:dx:1:trip-1");
  });

  it("keeps a trip button from another chat from resolving", async () => {
    rows.trips = [{ id: "trip-1", name: "HochlandKinder", start_date: "2026-07-25", end_date: null }];
    await runCallback("mg:ut:trip-from-elsewhere");

    // Falls back to this chat's own list rather than switching to it.
    expect(keyboard()).not.toContain("trip-from-elsewhere");
  });
});

/**
 * `/replace` reuses the `/manage` keyboard, which is most of why it is worth
 * having — and also the risk in it. The two browsers look alike, sit one tap
 * apart and disagree completely about what a tap on a photo means.
 */
describe("the /replace keyboard", () => {
  const PHOTO = "photo-1";

  beforeEach(() => {
    vi.resetModules();
    deadTable = null;
    apiResults = {};
    apiPayloads = [];
    rows = {
      users: { telegram_id: 42, display_name: "Leonard", is_owner: true },
      chats: { chat_id: CHAT_ID, type: "supergroup", title: "TrackTale", active_trip_id: "trip-1" },
      trips: { id: "trip-1", name: "HochlandKinder", start_date: "2026-07-25", end_date: null },
      days: {
        id: "day-1",
        date: "2026-07-25",
        notes: [{ id: "note-1", text: "Long climb", created_at: "2026-07-25T09:00:00Z" }],
        media: [
          { id: PHOTO, caption: "Sunrise over the pass", telegram_date: "2026-07-25T06:00:00Z" },
        ],
        track_segments: [],
        comments: [],
      },
      media: {
        caption: "Sunrise over the pass",
        storage_path: "trip-1/day-1/OLDoldOL.jpg",
        thumb_path: null,
      },
    };
  });

  const screen = () =>
    String(
      apiPayloads.find((c) => c.method === "editMessageText" || c.method === "sendMessage")
        ?.payload.text ?? "",
    );

  it("offers only photos, since only a photo has a picture to swap", async () => {
    // The day also holds a note. Listing it here would offer a swap that cannot
    // mean anything, and a tap on it would arm one against a row with no file.
    const calls = await runCallback("mg:rd:1:0");

    expect(calls[0]).toBe("answerCallbackQuery");
    expect(screen()).toContain("1 photo(s)");
    expect(screen()).not.toContain("Long climb");
  });

  it("waits for the new picture once a photo is picked", async () => {
    const calls = await runCallback(`mg:rp:1:${PHOTO}`);

    expect(calls[0]).toBe("answerCallbackQuery");
    expect(screen()).toContain("Now send me the new picture");
    // The old one is shown, because from here the next photo overwrites it.
    expect(screen()).toContain("Sunrise over the pass");
  });

  it("does not read a replace tap as a delete", async () => {
    // The collision worth guarding: both browsers encode "a photo on day 1",
    // and one of them is not undoable.
    await runCallback(`mg:rp:1:${PHOTO}`);
    expect(screen()).not.toContain("delete");
  });
});

/**
 * The other half of the same failure: a tap Telegram never delivers looks, from
 * the chat, exactly like a tap the bot fumbled. `/diag` is what tells them apart,
 * so what it reports has to be right about the case that matters.
 */
describe("/diag", () => {
  beforeEach(() => {
    vi.resetModules();
    deadTable = null;
    apiResults = {};
    apiPayloads = [];
    rows = {
      users: { telegram_id: 42, display_name: "Leonard", is_owner: true },
      chats: { chat_id: CHAT_ID, type: "supergroup", title: "TrackTale", active_trip_id: "trip-1" },
    };
  });

  const reply = () =>
    String(apiPayloads.find((c) => c.method === "sendMessage")?.payload.text ?? "");

  it("names a webhook that isn't subscribed to button taps", async () => {
    apiResults.getWebhookInfo = {
      url: "https://tracktale.example/api/telegram",
      pending_update_count: 0,
      allowed_updates: ["message"],
    };
    await runUpdate(commandUpdate("/diag"));

    expect(reply()).toContain("NOT delivered");
  });

  it("calls taps delivered when Telegram is on its own default", async () => {
    // No allowed_updates at all means everything but the chat-member types —
    // callback_query included. Reporting that as broken would send the owner
    // chasing the wrong thing.
    apiResults.getWebhookInfo = {
      url: "https://tracktale.example/api/telegram",
      pending_update_count: 3,
    };
    await runUpdate(commandUpdate("/diag"));

    expect(reply()).toContain("delivered ✅");
  });

  it("re-registers the webhook, taps included, on /diag fix", async () => {
    apiResults.getWebhookInfo = {
      url: "https://tracktale.example/api/telegram",
      pending_update_count: 0,
      allowed_updates: ["message"],
    };
    await runUpdate(commandUpdate("/diag fix"));

    const set = apiPayloads.find((c) => c.method === "setWebhook");
    expect(set?.payload.allowed_updates).toContain("callback_query");
    // The URL Telegram already has, not one guessed from an env var that may
    // not match the deployment answering right now.
    expect(set?.payload.url).toBe("https://tracktale.example/api/telegram");
  });

  it("stays shut for anyone who isn't the owner", async () => {
    rows.users = { telegram_id: 42, display_name: "Leonard", is_owner: false };
    await runUpdate(commandUpdate("/diag"));

    expect(apiPayloads.some((c) => c.method === "getWebhookInfo")).toBe(false);
  });
});

/**
 * The half of the fault no amount of handler code could reach.
 *
 * `allowed_updates` lives on Telegram's side and outlives every deploy, so a
 * webhook registered before the `/manage` keyboard existed goes on delivering
 * messages while dropping taps — and the bot cannot tell, because a dropped tap
 * arrives as nothing at all. Repairing it has to happen without anyone knowing
 * to ask for it, and it has to stop once it has, or every cold start writes to
 * Telegram again.
 */
describe("keeping the webhook subscribed to taps", () => {
  beforeEach(() => {
    vi.resetModules();
    deadTable = null;
    apiResults = {};
    apiPayloads = [];
    rows = {};
  });

  async function check(info: Record<string, unknown>) {
    const { createBot } = await import("./bot.server");
    const { ensureTapsDelivered } = await import("./bot-chrome.server");
    const bot = createBot();
    bot.api.config.use(async (_prev, method, payload) => {
      apiPayloads.push({ method, payload: payload as Record<string, unknown> });
      return { ok: true, result: apiResults[method] ?? true } as never;
    });
    apiResults.getWebhookInfo = info;
    return ensureTapsDelivered(bot);
  }

  const sent = (method: string) => apiPayloads.find((c) => c.method === method)?.payload;

  it("re-subscribes a webhook that was never asked for button taps", async () => {
    const result = await check({
      url: "https://tracktale.example/api/telegram",
      pending_update_count: 0,
      allowed_updates: ["message", "edited_message"],
    });

    expect(result).toBe("repaired");
    expect(sent("setWebhook")?.allowed_updates).toContain("callback_query");
    // Telegram's URL, not one rebuilt from this deploy's env — the webhook may
    // well point at a different deployment than the one running this check.
    expect(sent("setWebhook")?.url).toBe("https://tracktale.example/api/telegram");
  });

  it("says so in the chat, since the fault itself was silent", async () => {
    await check({
      url: "https://tracktale.example/api/telegram",
      pending_update_count: 0,
      allowed_updates: ["message"],
    });

    expect(String(sent("sendMessage")?.text ?? "")).toContain("/manage");
    expect(sent("sendMessage")?.chat_id).toBe(42);
  });

  it("leaves Telegram's own default alone", async () => {
    // No allowed_updates means everything bar the chat-member types, taps
    // included. Rewriting that would be a change for its own sake.
    const result = await check({
      url: "https://tracktale.example/api/telegram",
      pending_update_count: 3,
    });

    expect(result).toBe("ok");
    expect(apiPayloads.some((c) => c.method === "setWebhook")).toBe(false);
  });

  it("leaves a subscription that already covers everything alone", async () => {
    // The state a repair leaves behind: it has to read as fine on the next cold
    // start, or every one of them writes to Telegram again.
    const result = await check({
      url: "https://tracktale.example/api/telegram",
      pending_update_count: 0,
      allowed_updates: ["message", "edited_message", "callback_query", "my_chat_member"],
    });

    expect(result).toBe("ok");
    expect(apiPayloads.some((c) => c.method === "setWebhook")).toBe(false);
  });
});
