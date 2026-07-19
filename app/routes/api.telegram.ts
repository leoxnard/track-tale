import type { Bot } from "grammy";
import { createBot } from "../lib/bot.server";
import { env } from "../lib/env.server";

let bot: Bot | undefined;
let initPromise: Promise<void> | undefined;

async function getBot(): Promise<Bot> {
  bot ??= createBot();
  initPromise ??= bot.init();
  await initPromise;
  return bot;
}

export async function action({ request }: { request: Request }) {
  if (request.headers.get("x-telegram-bot-api-secret-token") !== env.telegramWebhookSecret) {
    return new Response("forbidden", { status: 403 });
  }
  const update = await request.json();
  try {
    await (await getBot()).handleUpdate(update);
  } catch (err) {
    // Always 200 so Telegram doesn't endlessly retry a poison update.
    console.error("telegram update failed", err);
  }
  return new Response("ok");
}
