/**
 * Helpers for text that ends up in a message sent with `parse_mode: "Markdown"`.
 *
 * Telegram rejects the *whole* message when an entity is left open, so a single
 * stray underscore in a trip name, a traveller's first name or a guestbook
 * comment silently costs the user the entire reply. Anything not written by us
 * has to come through here first.
 */
import { customAlphabet } from "nanoid";

/**
 * Alphanumeric only. nanoid's default alphabet includes "_" and "-", which
 * Telegram's Markdown parser reads as formatting — a slug containing one breaks
 * the entire message, and roughly 40% of 16-character ids contain one.
 */
export const slugId = customAlphabet(
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
);

/** Neutralise Markdown syntax in text we did not write ourselves. */
export function escapeMd(s: string): string {
  return s.replace(/([_*`\[\]])/g, "\\$1");
}

/** Error text is often echoed back to the user, and may carry any character. */
export function escapeErr(err: unknown): string {
  return escapeMd(err instanceof Error ? err.message : "unknown error");
}
