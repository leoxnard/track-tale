import { InlineKeyboard, type Bot, type Context } from "grammy";
import { env } from "./env.server";
import { supabase } from "./supabase.server";
import { encodeAction, type ItemKind } from "./manage";
import type { View } from "./manage.server";
import type { EntityType } from "./entities.server";

/**
 * The bot's plumbing: putting a screen on the chat, remembering what a message
 * created, pulling a file back off Telegram, and keeping the webhook subscribed
 * to what it needs.
 *
 * None of it knows anything about trips, days or photos, which is why it sits
 * apart from the handlers that do.
 */

/**
 * Remember which row a confirmation message created, so replying /delete to it
 * removes exactly that thing — and /undo can walk back the most recent one.
 */
export async function recordAction(
  ctx: Context,
  sent: { message_id: number } | undefined,
  entityType: EntityType,
  entityId: string,
) {
  if (!sent || !ctx.chat) return;
  await supabase().from("bot_actions").insert({
    chat_id: ctx.chat.id,
    message_id: sent.message_id,
    entity_type: entityType,
    entity_id: entityId,
  });
}

/**
 * What every confirmation carries: the way to take that one thing back off.
 *
 * The reply-`/delete` route still works, but it asks the traveller to remember
 * a command and to reply to the right message. The button is the same journey
 * through the /manage screens — tapping it opens the confirmation for exactly
 * this item, in place of the confirmation it was attached to.
 */
export function undoKeyboard(kind: ItemKind, id: string, dayNumber: number): InlineKeyboard {
  const keyboard = new InlineKeyboard().text(
    "🗑 Delete this",
    encodeAction({ type: "ask", kind, id, dayNumber }),
  );
  // A photo is the one thing whose picture can be changed without losing what
  // the row means, and the moment right after sending it is when a better
  // version is most likely to be to hand.
  if (kind === "media") {
    keyboard.text("🔄 Swap picture", encodeAction({ type: "replacePick", id, dayNumber }));
  }
  return keyboard.text(`📅 Day ${dayNumber}`, encodeAction({ type: "day", dayNumber, page: 0 }));
}

/**
 * Send a /manage screen as a new message, and swap one for the next in place.
 *
 * Editing keeps the whole browse-and-delete flow in a single message instead of
 * pushing a new one into the chat on every tap. Telegram rejects an edit whose
 * text and keyboard are both unchanged, which is a normal thing to happen when
 * a button is tapped twice — that one is not worth surfacing.
 */
export async function sendView(ctx: Context, view: View) {
  await ctx.reply(view.text, {
    reply_markup: view.keyboard,
    ...(view.markdown ? { parse_mode: "Markdown" as const } : {}),
    link_preview_options: { is_disabled: !view.preview },
  });
}

/**
 * Swap the current screen for the next one, and never fail silently.
 *
 * A tapped button that produces no visible change at all is the worst outcome
 * here: the traveller cannot tell a broken bot from a slow one. So the screen
 * gets three chances — edited in place, sent as a new message, then sent again
 * with the formatting stripped, since an unbalanced `_` or `*` in a note the
 * screen quotes is enough for Telegram to reject the same text twice — and if
 * none of them land, the reason itself goes into the chat.
 */
export async function editView(ctx: Context, view: View) {
  try {
    await ctx.editMessageText(view.text, {
      reply_markup: view.keyboard,
      ...(view.markdown ? { parse_mode: "Markdown" as const } : {}),
      link_preview_options: { is_disabled: !view.preview },
    });
    return;
  } catch {
    // The message is too old to edit, or nothing about it changed. Either way
    // the traveller still needs to see the screen they asked for.
  }

  try {
    await sendView(ctx, view);
    return;
  } catch (err) {
    if (!view.markdown) {
      await reportViewFailure(ctx, err);
      return;
    }
  }

  try {
    await sendView(ctx, { ...view, markdown: false });
  } catch (err) {
    await reportViewFailure(ctx, err);
  }
}

async function reportViewFailure(ctx: Context, err: unknown) {
  console.error("could not show a /manage screen", err);
  await ctx
    .reply(
      `⚠️ I couldn't show that screen: ${err instanceof Error ? err.message : "unknown error"}\n\n` +
        `Nothing was changed. /manage starts again.`,
      { link_preview_options: { is_disabled: true } },
    )
    .catch(() => {});
}

/**
 * What the webhook must be subscribed to. Telegram's own default is wider than
 * this, but a webhook registered with an explicit list keeps whatever list it
 * was given — including one that forgot `callback_query` and so drops every
 * button tap in silence.
 */
export const WEBHOOK_UPDATES = [
  "message",
  "edited_message",
  "callback_query",
  "my_chat_member",
] as const;

/**
 * Make sure Telegram is actually sending us button taps, and put it right if
 * not.
 *
 * The subscription lives on Telegram's side, not in this repository: it is
 * whatever the last `setWebhook` call said, months ago, from a shell. Nothing a
 * deploy does can change it. So a webhook registered with an `allowed_updates`
 * list that predates the `/manage` keyboard keeps delivering messages happily
 * while dropping every tap before it leaves Telegram — and no amount of fixing
 * the handler helps, because the handler is never reached. That is invisible
 * from the chat, and it survives exactly the kind of "fixed it, still broken"
 * loop that costs an afternoon.
 *
 * `/diag fix` says the same thing out loud, but it has to be run by the owner
 * who already knows to suspect this. Doing it here means the deploy that ships
 * a new kind of update also subscribes to it.
 *
 * A missing `allowed_updates` is Telegram's default, which already includes
 * everything we want — so it is left alone, and this only ever writes when the
 * list is present and short. That makes it converge after one call rather than
 * re-registering on every cold start.
 */
export async function ensureTapsDelivered(bot: Bot): Promise<"ok" | "repaired"> {
  const info = await bot.api.getWebhookInfo();
  const allowed = info.allowed_updates;
  if (!allowed || WEBHOOK_UPDATES.every((u) => allowed.includes(u))) return "ok";

  // The URL Telegram already has, not one built from an env var: this deploy is
  // not necessarily the one the webhook points at, and pointing it here would
  // be a much bigger change than the one being made.
  await bot.api.setWebhook(info.url || `${env.appOrigin}/api/telegram`, {
    secret_token: env.telegramWebhookSecret,
    allowed_updates: [...WEBHOOK_UPDATES],
  });

  // Say so, or the repair is as invisible as the fault was. The owner is the
  // one who has been tapping buttons that did nothing.
  await bot.api
    .sendMessage(
      env.ownerTelegramId,
      `🔧 Telegram was only delivering: ${allowed.join(", ")}.\n\n` +
        `Button taps were being dropped before they reached the bot, which is why ` +
        `/manage buttons hung on "Loading…". Fixed — it now delivers ` +
        `${WEBHOOK_UPDATES.join(", ")}.\n\nSend /manage and tap a day.`,
    )
    .catch(() => {});

  return "repaired";
}

export async function downloadTelegramFile(bot: Bot, fileId: string): Promise<ArrayBuffer> {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) throw new Error("Telegram returned no file path");
  const res = await fetch(`https://api.telegram.org/file/bot${env.telegramBotToken}/${file.file_path}`);
  if (!res.ok) throw new Error(`Telegram file download failed: ${res.status}`);
  return res.arrayBuffer();
}

/** Bot API caps downloads well below what a full-resolution photo can weigh. */
export const TELEGRAM_DOWNLOAD_LIMIT = 20 * 1024 * 1024;
