import { Bot } from "grammy";
import { env } from "./env.server";
import { supabase } from "./supabase.server";
import { escapeMd } from "./telegram-md";
import { DEFAULT_LOCALE, messages, type Locale } from "./i18n";

export interface NewComment {
  slug: string;
  dayNumber: number;
  authorName: string;
  text: string;
  /** Language the visitor is reading the page in — errors go back to them. */
  locale?: Locale;
}

export type CommentResult = { ok: true } | { ok: false; error: string };

const MAX_NAME = 40;
const MAX_TEXT = 800;
/** A whole family posting at once is fine; a stuck finger is not. */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 8;

export async function postComment(input: NewComment): Promise<CommentResult> {
  const err = messages(input.locale ?? DEFAULT_LOCALE).guestbook.errors;
  const authorName = input.authorName.trim().slice(0, MAX_NAME);
  const text = input.text.trim().slice(0, MAX_TEXT);
  if (!authorName) return { ok: false, error: err.noName };
  if (!text) return { ok: false, error: err.noText };

  const db = supabase();

  const { data: trip } = await db
    .from("trips")
    .select("id, name, chat_id")
    .eq("share_slug", input.slug)
    .maybeSingle();
  if (!trip) return { ok: false, error: err.noTrip };

  const { data: day } = await db
    .from("days")
    .select("id, day_number")
    .eq("trip_id", trip.id)
    .eq("day_number", input.dayNumber)
    .maybeSingle();
  if (!day) return { ok: false, error: err.noDay };

  const since = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
  const { count } = await db
    .from("comments")
    .select("*", { count: "exact", head: true })
    .eq("day_id", day.id)
    .gt("created_at", since);
  if ((count ?? 0) >= RATE_MAX) {
    return { ok: false, error: err.tooMany };
  }

  const { data: inserted, error } = await db
    .from("comments")
    .insert({ day_id: day.id, author_name: authorName, text })
    .select("id")
    .single();
  if (error) return { ok: false, error: err.saveFailed };

  // Relay to the travellers so encouragement reaches them on the road. Name,
  // message and trip name are all written by other people, so every one of them
  // has to be escaped — an unmatched "_" would make Telegram reject the relay
  // and the family would never know their message went nowhere.
  try {
    const bot = new Bot(env.telegramBotToken);
    const sent = await bot.api.sendMessage(
      trip.chat_id,
      `💬 *${escapeMd(authorName)}* on day ${day.day_number} of ${escapeMd(trip.name)}:\n` +
        `${escapeMd(text)}\n\n_Reply /delete to remove it._`,
      { parse_mode: "Markdown" },
    );
    await db.from("bot_actions").insert({
      chat_id: trip.chat_id,
      message_id: sent.message_id,
      entity_type: "comment",
      entity_id: inserted.id,
    });
  } catch (err) {
    // The comment is saved, so the post still succeeds — but a relay that keeps
    // failing is invisible from the outside, so make sure it reaches the logs.
    console.error("comment relay to Telegram failed", { tripId: trip.id, dayNumber: day.day_number }, err);
  }

  return { ok: true };
}
