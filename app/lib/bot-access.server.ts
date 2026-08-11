import type { Context } from "grammy";
import { env } from "./env.server";
import {
  chatHasTrips,
  createUser,
  ensureChat,
  ensureDay,
  getActiveTrip,
  getUser,
  redeemInvite,
  INVITE_TTL_DAYS,
  type DbChat,
  type DbTrip,
} from "./db.server";

/**
 * Who is allowed to do what, and which trip and day they are doing it to.
 *
 * Every handler starts here, so it is worth having in one place rather than
 * spread through the command list.
 */

export interface BotState {
  chat: DbChat;
  senderId: number;
  senderName: string;
  isGroup: boolean;
  isRegistered: boolean;
  isOwner: boolean;
}

/**
 * Decide whether we may act on this update, and gather sender identity.
 *
 * Private chats require a registered user. Groups are trusted once they contain
 * a trip — the person who created it was registered, and a private group's
 * members are there by invitation.
 */
export async function authorize(ctx: Context): Promise<BotState | null> {
  const from = ctx.from;
  const chat = ctx.chat;
  if (!from || !chat) return null;

  const isGroup = chat.type === "group" || chat.type === "supergroup";
  const senderName = from.first_name ?? "Someone";

  let user = await getUser(from.id);
  if (!user && from.id === env.ownerTelegramId) {
    user = await createUser(from.id, senderName, true);
  }

  // An unregistered sender in a private chat can still redeem an invite code.
  let triedCode = false;
  if (!user && !isGroup) {
    const text = ctx.message?.text?.trim() ?? "";
    const codeMatch = text.match(/^(?:\/start\s+)?([A-Za-z0-9_-]{8,21})$/);
    if (codeMatch) {
      triedCode = true;
      // Redemption registers the sender itself — the code and the user row have
      // to be written in the same transaction to survive a race for the code.
      user = await redeemInvite(codeMatch[1], from.id, senderName);
      if (user) {
        await ctx.reply("✅ Welcome to TrackTale! Send /help to see how it works.").catch(() => {});
      }
    }
  }

  // Check access before touching the database, so an unknown group that adds
  // the bot cannot make us create rows for it.
  const allowed = user !== null || (isGroup && (await chatHasTrips(chat.id)));
  if (!allowed) {
    if (ctx.message && !isGroup) {
      await ctx
        .reply(
          triedCode
            ? `🔒 That code doesn't work — invite codes last ${INVITE_TTL_DAYS} days and can only be used once. Ask for a fresh one.`
            : "🔒 This is a private bot. Ask the owner for an invite code and send it here.",
        )
        .catch(() => {});
    }
    return null;
  }

  const dbChat = await ensureChat(
    chat.id,
    chat.type,
    isGroup && "title" in chat ? chat.title : undefined,
  );

  return {
    chat: dbChat,
    senderId: from.id,
    senderName,
    isGroup,
    isRegistered: user !== null,
    isOwner: user?.is_owner ?? false,
  };
}

/**
 * Ending or deleting a trip is not something any passer-by in a group should be
 * able to do — it stays with whoever created it (and the bot's owner).
 */
export async function requireTripManager(ctx: Context, trip: DbTrip): Promise<boolean> {
  const { senderId, isOwner } = ctx.state;
  if (senderId === trip.owner_telegram_id || isOwner) return true;
  await ctx.reply("Only the traveller who created this trip can do that.");
  return false;
}

export async function requireTrip(ctx: Context): Promise<DbTrip | null> {
  const { chat } = ctx.state;
  const trip = await getActiveTrip(chat);
  if (!trip) {
    await ctx.reply(
      "No active trip here. Create one:\n/newtrip Name | 2026-08-01",
    );
    return null;
  }
  return trip;
}

export async function requireDay(ctx: Context, trip: DbTrip) {
  if (!trip.current_day_number) {
    await ctx.reply("Which day is this? Set it first, e.g. /day 1");
    return null;
  }
  return ensureDay(trip, trip.current_day_number);
}

declare module "grammy" {
  interface Context {
    state: BotState;
  }
}
