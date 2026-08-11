import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Update } from "grammy/types";

/**
 * Redeeming an invite code, driven through the real bot.
 *
 * This exists because the feature shipped broken and stayed broken for weeks
 * without leaving a trace. `invites.used_by` references `users(telegram_id)`,
 * and the bot used to stamp the code before creating the row it points at — so
 * every redemption tripped the foreign key, the error was dropped on the floor,
 * and the sender was told their code "doesn't work". Nothing distinguished that
 * from a genuinely expired code, in the chat or in the logs.
 *
 * So the assertions here are about *how* the redemption is written, not only
 * that a welcome comes back: registering the sender has to travel with the
 * claim, in the one database call that can hold both.
 */

process.env.TELEGRAM_BOT_TOKEN = "1:TEST";
process.env.TELEGRAM_WEBHOOK_SECRET = "secret";
process.env.TELEGRAM_OWNER_ID = "42";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "service-key";
process.env.CRON_SECRET = "cron";

const STRANGER_ID = 7001;

/** What each table answers with. No user rows: the sender is a stranger. */
let rows: Record<string, unknown>;
/** What `redeem_invite` settles to, and what it was handed. */
let rpcResult: { data: unknown; error: unknown };
let rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
/** Writes that go straight at a table, so a test can catch one that shouldn't. */
let tableWrites: { table: string; method: string }[] = [];

vi.mock("./supabase.server", () => {
  const chain = (table: string): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "then") {
            return (onOk: unknown, onErr: unknown) =>
              Promise.resolve({ data: rows[table] ?? null, error: null, count: 0 }).then(
                onOk as never,
                onErr as never,
              );
          }
          if (prop === "insert" || prop === "update" || prop === "upsert") {
            return () => {
              tableWrites.push({ table, method: prop });
              return chain(table);
            };
          }
          return () => chain(table);
        },
      },
    );

  return {
    supabase: () => ({
      from: (table: string) => chain(table),
      rpc: async (name: string, args: Record<string, unknown>) => {
        rpcCalls.push({ name, args });
        return rpcResult;
      },
    }),
  };
});

/** A stranger sending something in a private chat — the only place codes work. */
function privateMessage(text: string): Update {
  return {
    update_id: 1,
    message: {
      message_id: 3,
      date: Math.floor(Date.now() / 1000),
      chat: { id: STRANGER_ID, type: "private" },
      from: { id: STRANGER_ID, is_bot: false, first_name: "Mira" },
      text,
    },
  } as unknown as Update;
}

/** Runs one update through a real bot and collects what it said. */
async function runUpdate(update: Update): Promise<string[]> {
  const { createBot } = await import("./bot.server");
  const bot = createBot();
  const said: string[] = [];

  bot.api.config.use(async (_prev, method, payload) => {
    if (method === "sendMessage") {
      said.push(String((payload as { text?: string }).text ?? ""));
    }
    return { ok: true, result: true } as never;
  });
  bot.botInfo = {
    id: 1,
    is_bot: true,
    first_name: "TrackTale",
    username: "tracktale_bot",
  } as unknown as typeof bot.botInfo;

  await bot.handleUpdate(update);
  return said;
}

describe("redeeming an invite code", () => {
  beforeEach(() => {
    vi.resetModules();
    rpcCalls = [];
    tableWrites = [];
    // No `users` row: nobody has met this sender before.
    rows = { chats: { chat_id: STRANGER_ID, type: "private", active_trip_id: null } };
    rpcResult = { data: null, error: null };
  });

  it("lets a stranger in on a good code", async () => {
    rpcResult = {
      data: { telegram_id: STRANGER_ID, display_name: "Mira", is_owner: false },
      error: null,
    };

    const said = await runUpdate(privateMessage("aMwUwFGzYM"));

    expect(said[0]).toContain("Welcome to TrackTale");
  });

  it("registers the sender inside the claim, not as a write of its own", async () => {
    // The bug. A separate insert is either too late for the foreign key or too
    // early to be safe: a code lost in a race would still leave its loser
    // registered. Both halves belong to the one call that can be a transaction.
    rpcResult = {
      data: { telegram_id: STRANGER_ID, display_name: "Mira", is_owner: false },
      error: null,
    };

    await runUpdate(privateMessage("aMwUwFGzYM"));

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].name).toBe("redeem_invite");
    expect(rpcCalls[0].args).toMatchObject({
      p_code: "aMwUwFGzYM",
      p_telegram_id: STRANGER_ID,
      p_display_name: "Mira",
    });
    expect(tableWrites.filter((w) => w.table === "users")).toEqual([]);
  });

  it("reads a code out of a /start deep link too", async () => {
    rpcResult = {
      data: { telegram_id: STRANGER_ID, display_name: "Mira", is_owner: false },
      error: null,
    };

    await runUpdate(privateMessage("/start aMwUwFGzYM"));

    expect(rpcCalls[0]?.args).toMatchObject({ p_code: "aMwUwFGzYM" });
  });

  it("turns away a code the database would not spend, and says why", async () => {
    const said = await runUpdate(privateMessage("aMwUwFGzYM"));

    expect(said[0]).toContain("doesn't work");
    // The refusal has to name the terms, or a stale code looks like a broken bot.
    expect(said[0]).toContain("7 days");
  });

  it("says something different to someone who sent no code at all", async () => {
    const said = await runUpdate(privateMessage("hello?"));

    expect(rpcCalls).toEqual([]);
    expect(said[0]).toContain("Ask the owner for an invite code");
  });

  it("stays quiet rather than guessing when the redemption itself fails", async () => {
    // A database that is down must not read as an expired code — the middleware
    // logs the throw, and the sender is left alone rather than misinformed.
    rpcResult = { data: null, error: new Error("connection refused") };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const said = await runUpdate(privateMessage("aMwUwFGzYM"));

    expect(said).toEqual([]);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });
});
