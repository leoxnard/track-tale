/**
 * The `/manage` browser: picking any note, photo, track or guestbook message
 * out of a trip and deleting it, however long ago it was added.
 *
 * `/undo` and a `/delete` reply both need the bot's own confirmation message to
 * still be reachable in the chat, which rules out anything older than the
 * traveller's scrollback — and rules out entirely anything added before a chat
 * was cleared. This walks the trip itself instead, so nothing is ever stuck.
 *
 * Everything here is pure: the callback payloads Telegram round-trips through
 * its buttons have a hard 64-byte limit, so encoding them is exactly the part
 * worth testing without a database in the way.
 */

/**
 * The kinds of thing that sit on a day. Three of them the traveller added;
 * the fourth is a guestbook message from the family, which until now had no
 * way off the page at all.
 */
export type ItemKind = "note" | "media" | "track_segment" | "comment";

/** One byte per kind, because the id alone already costs 36 of the 64. */
const KIND_CODE: Record<ItemKind, string> = {
  note: "n",
  media: "p",
  track_segment: "t",
  comment: "c",
};

const CODE_KIND: Record<string, ItemKind> = {
  n: "note",
  p: "media",
  t: "track_segment",
  c: "comment",
};

export const KIND_ICON: Record<ItemKind, string> = {
  note: "📝",
  media: "📸",
  track_segment: "🛤️",
  comment: "💬",
};

export const KIND_NOUN: Record<ItemKind, string> = {
  note: "note",
  media: "photo",
  track_segment: "track",
  comment: "guestbook message",
};

/**
 * Items per page. Telegram allows far more buttons than this, but a day with
 * forty photos in one keyboard is a wall to scroll past on a phone.
 */
export const PAGE_SIZE = 12;

export type ManageAction =
  | { type: "home" }
  /**
   * Not a screen: the self-test button `/diag` hands out. A tap that never
   * arrives looks exactly like a tap the bot mishandled — Telegram's spinner
   * and nothing else — and this is the one payload whose handling touches no
   * trip, no day and no database, so an answer means delivery works.
   */
  | { type: "ping" }
  | { type: "day"; dayNumber: number; page: number }
  /** Selected, awaiting the second tap — deleting is not undoable. */
  | { type: "ask"; kind: ItemKind; id: string; dayNumber: number }
  | { type: "confirm"; kind: ItemKind; id: string; dayNumber: number };

const PREFIX = "mg";

export function encodeAction(action: ManageAction): string {
  switch (action.type) {
    case "home":
      return `${PREFIX}:h`;
    case "ping":
      return `${PREFIX}:k`;
    case "day":
      return `${PREFIX}:d:${action.dayNumber}:${action.page}`;
    case "ask":
      return `${PREFIX}:a:${KIND_CODE[action.kind]}:${action.dayNumber}:${action.id}`;
    case "confirm":
      return `${PREFIX}:y:${KIND_CODE[action.kind]}:${action.dayNumber}:${action.id}`;
  }
}

/**
 * Read a payload back. Returns null for anything unrecognised — a button from
 * an older deploy is a normal thing to be tapped, not an error worth throwing.
 */
export function parseAction(data: string): ManageAction | null {
  const parts = data.split(":");
  if (parts[0] !== PREFIX) return null;

  switch (parts[1]) {
    case "h":
      return { type: "home" };
    case "k":
      return { type: "ping" };
    case "d": {
      const dayNumber = Number(parts[2]);
      const page = Number(parts[3]);
      if (!Number.isInteger(dayNumber) || !Number.isInteger(page) || page < 0) return null;
      return { type: "day", dayNumber, page };
    }
    case "a":
    case "y": {
      const kind = CODE_KIND[parts[2]];
      const dayNumber = Number(parts[3]);
      // Ids are opaque to us, but an empty one would delete nothing and say it did.
      const id = parts.slice(4).join(":");
      if (!kind || !Number.isInteger(dayNumber) || id.length === 0) return null;
      return { type: parts[1] === "a" ? "ask" : "confirm", kind, id, dayNumber };
    }
    default:
      return null;
  }
}

/**
 * Squash a note or caption onto the one line a button gives us.
 *
 * Telegram renders button labels on a single line and silently truncates long
 * ones mid-word, so newlines are folded and the cut is made here where an
 * ellipsis can mark it.
 */
export function shortLabel(text: string | null | undefined, max = 28): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "";
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

export interface ManageItem {
  kind: ItemKind;
  id: string;
  /** What the button says, after the icon. */
  label: string;
  /** Sort key within a day: when the thing happened. */
  at: number;
}

/** One page of a day's items, plus what the paging buttons should offer. */
export function paginate<T>(items: T[], page: number): {
  items: T[];
  page: number;
  pageCount: number;
} {
  const pageCount = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const clamped = Math.min(Math.max(page, 0), pageCount - 1);
  return {
    items: items.slice(clamped * PAGE_SIZE, clamped * PAGE_SIZE + PAGE_SIZE),
    page: clamped,
    pageCount,
  };
}

/** "📝 2 · 📸 5 · 🛤️ 1", leaving out whatever a day hasn't got. */
export function countSummary(counts: Record<ItemKind, number>): string {
  const parts: string[] = [];
  for (const kind of ["track_segment", "media", "note", "comment"] as ItemKind[]) {
    if (counts[kind] > 0) parts.push(`${KIND_ICON[kind]} ${counts[kind]}`);
  }
  return parts.join(" · ");
}
