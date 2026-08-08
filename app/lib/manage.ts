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

/**
 * Which list a day picker is driving: the day uploads land on, or the day
 * `/clearday` is about to empty. Same screen, two very different second taps.
 */
export type DayPickerMode = "set" | "clear";

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
  | { type: "confirm"; kind: ItemKind; id: string; dayNumber: number }
  /** The day picker itself: every day the trip has, plus the next one. */
  | { type: "days"; page: number; mode: DayPickerMode }
  | { type: "setday"; dayNumber: number }
  | { type: "trips" }
  | { type: "usetrip"; id: string }
  /** The /trip screen, which is also where the other screens come back to. */
  | { type: "status" }
  | { type: "reminders"; on: boolean }
  | { type: "endtrip"; confirmed: boolean }
  | { type: "clearday"; dayNumber: number; confirmed: boolean }
  | { type: "deletetrips" }
  | { type: "deletetrip"; id: string; confirmed: boolean }
  | { type: "liveoff" }
  /** Both of these kill a link someone may already have been given. */
  | { type: "relink"; confirmed: boolean }
  | { type: "mypagelink"; confirmed: boolean }
  | { type: "mergefinish" }
  | { type: "mergecancel" };

const PREFIX = "mg";

const MODE_CODE: Record<DayPickerMode, string> = { set: "s", clear: "c" };
const CODE_MODE: Record<string, DayPickerMode> = { s: "set", c: "clear" };

/** "1" or "0" — a confirmed second tap, or the question that precedes it. */
function flag(on: boolean): string {
  return on ? "1" : "0";
}

function readFlag(part: string | undefined): boolean | null {
  if (part === "1") return true;
  if (part === "0") return false;
  return null;
}

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
    case "days":
      return `${PREFIX}:dp:${action.page}:${MODE_CODE[action.mode]}`;
    case "setday":
      return `${PREFIX}:sd:${action.dayNumber}`;
    case "trips":
      return `${PREFIX}:tp`;
    case "usetrip":
      return `${PREFIX}:ut:${action.id}`;
    case "status":
      return `${PREFIX}:ts`;
    case "reminders":
      return `${PREFIX}:rm:${flag(action.on)}`;
    case "endtrip":
      return `${PREFIX}:et:${flag(action.confirmed)}`;
    case "clearday":
      return `${PREFIX}:cd:${action.dayNumber}:${flag(action.confirmed)}`;
    case "deletetrips":
      return `${PREFIX}:dt`;
    case "deletetrip":
      return `${PREFIX}:dx:${flag(action.confirmed)}:${action.id}`;
    case "liveoff":
      return `${PREFIX}:lo`;
    case "relink":
      return `${PREFIX}:rl:${flag(action.confirmed)}`;
    case "mypagelink":
      return `${PREFIX}:mp:${flag(action.confirmed)}`;
    case "mergefinish":
      return `${PREFIX}:mf`;
    case "mergecancel":
      return `${PREFIX}:mx`;
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
    case "dp": {
      const page = Number(parts[2]);
      const mode = CODE_MODE[parts[3]];
      if (!Number.isInteger(page) || page < 0 || !mode) return null;
      return { type: "days", page, mode };
    }
    case "sd": {
      const dayNumber = Number(parts[2]);
      if (!Number.isInteger(dayNumber) || dayNumber < 1) return null;
      return { type: "setday", dayNumber };
    }
    case "tp":
      return { type: "trips" };
    case "ut": {
      const id = parts.slice(2).join(":");
      return id.length > 0 ? { type: "usetrip", id } : null;
    }
    case "ts":
      return { type: "status" };
    case "rm": {
      const on = readFlag(parts[2]);
      return on === null ? null : { type: "reminders", on };
    }
    case "et": {
      const confirmed = readFlag(parts[2]);
      return confirmed === null ? null : { type: "endtrip", confirmed };
    }
    case "cd": {
      const dayNumber = Number(parts[2]);
      const confirmed = readFlag(parts[3]);
      if (!Number.isInteger(dayNumber) || dayNumber < 1 || confirmed === null) return null;
      return { type: "clearday", dayNumber, confirmed };
    }
    case "dt":
      return { type: "deletetrips" };
    case "dx": {
      const confirmed = readFlag(parts[2]);
      const id = parts.slice(3).join(":");
      if (confirmed === null || id.length === 0) return null;
      return { type: "deletetrip", id, confirmed };
    }
    case "lo":
      return { type: "liveoff" };
    case "rl": {
      const confirmed = readFlag(parts[2]);
      return confirmed === null ? null : { type: "relink", confirmed };
    }
    case "mp": {
      const confirmed = readFlag(parts[2]);
      return confirmed === null ? null : { type: "mypagelink", confirmed };
    }
    case "mf":
      return { type: "mergefinish" };
    case "mx":
      return { type: "mergecancel" };
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
