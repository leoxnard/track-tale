import { Bot } from "grammy";
import { env } from "./env.server";
import { supabase } from "./supabase.server";

export interface NewComment {
  slug: string;
  dayNumber: number;
  authorName: string;
  text: string;
}

export type CommentResult = { ok: true } | { ok: false; error: string };

const MAX_NAME = 40;
const MAX_TEXT = 800;
/** A whole family posting at once is fine; a stuck finger is not. */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 8;

export async function postComment(input: NewComment): Promise<CommentResult> {
  const authorName = input.authorName.trim().slice(0, MAX_NAME);
  const text = input.text.trim().slice(0, MAX_TEXT);
  if (!authorName) return { ok: false, error: "Add your name so they know who wrote it." };
  if (!text) return { ok: false, error: "Write a message first." };

  const db = supabase();

  const { data: trip } = await db
    .from("trips")
    .select("id, name, chat_id")
    .eq("share_slug", input.slug)
    .maybeSingle();
  if (!trip) return { ok: false, error: "This trip no longer exists." };

  const { data: day } = await db
    .from("days")
    .select("id, day_number")
    .eq("trip_id", trip.id)
    .eq("day_number", input.dayNumber)
    .maybeSingle();
  if (!day) return { ok: false, error: "That day isn't part of the trip." };

  const since = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
  const { count } = await db
    .from("comments")
    .select("*", { count: "exact", head: true })
    .eq("day_id", day.id)
    .gt("created_at", since);
  if ((count ?? 0) >= RATE_MAX) {
    return { ok: false, error: "That's a lot of messages at once — try again in a minute." };
  }

  const { data: inserted, error } = await db
    .from("comments")
    .insert({ day_id: day.id, author_name: authorName, text })
    .select("id")
    .single();
  if (error) return { ok: false, error: "Could not save your message." };

  // Relay to the travellers so encouragement reaches them on the road.
  try {
    const bot = new Bot(env.telegramBotToken);
    const sent = await bot.api.sendMessage(
      trip.chat_id,
      `💬 *${authorName}* on day ${day.day_number} of ${trip.name}:\n${text}\n\n_Reply /delete to remove it._`,
      { parse_mode: "Markdown" },
    );
    await db.from("bot_actions").insert({
      chat_id: trip.chat_id,
      message_id: sent.message_id,
      entity_type: "comment",
      entity_id: inserted.id,
    });
  } catch {
    // the comment is saved; a failed relay must not fail the post
  }

  return { ok: true };
}
