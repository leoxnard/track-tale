import type { Bot } from "grammy";
import { createBot, ensureTapsDelivered } from "../lib/bot.server";
import { env } from "../lib/env.server";

let bot: Bot | undefined;
let initPromise: Promise<void> | undefined;
let subscriptionChecked: Promise<unknown> | undefined;

async function getBot(): Promise<Bot> {
  bot ??= createBot();
  initPromise ??= bot.init();
  await initPromise;

  // Once per process, alongside the getMe call grammy already makes on init.
  // It costs one more round trip on a cold start and writes only when the
  // webhook is genuinely subscribed to too little — but it is the difference
  // between a broken subscription being fixed by the next deploy and it sitting
  // there dropping every button tap until someone thinks to ask Telegram.
  //
  // Awaited on purpose: a promise left running past the response is not
  // guaranteed to survive on a serverless host, and a check that only sometimes
  // happens is worse than no check at all. It must never block the update
  // itself, so a failure here is logged and nothing more.
  subscriptionChecked ??= ensureTapsDelivered(bot).catch((err) => {
    console.error("could not check what Telegram is delivering", err);
  });
  await subscriptionChecked;

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
