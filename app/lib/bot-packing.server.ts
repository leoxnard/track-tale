import { InlineKeyboard } from "grammy";
import { encodeAction, paginate, PAGE_SIZE, type PackField, type PackMode } from "./manage";
import type { View } from "./manage.server";
import { escapeMd } from "./telegram-md";
import { deleteEntity } from "./entities.server";
import type { DbTrip } from "./db.server";
import {
  categoriesOf,
  cleanField,
  groupByCategory,
  normaliseUrl,
  packItemLine,
  MAX_CATEGORY,
  MAX_MODEL,
  MAX_TITLE,
  type PackFields,
} from "./packing";
import {
  addPackItem,
  clearPackSession,
  getPackItem,
  getPackSession,
  listPackItems,
  setPackSession,
  updatePackItem,
  type PackItem,
  type PackSession,
} from "./packing.server";

/**
 * `/pack` — the packing list as a conversation.
 *
 * The first version took a whole entry on one line, fields separated by bars.
 * It worked and nobody used it: `/pack Tent | Hilleberg Anjan 2 | https://…`
 * is a syntax to remember, typed on a phone, and getting a bar in the wrong
 * place means retyping the lot. So the bot asks instead — name, then model,
 * then link, then which category it belongs in — one short message at a time,
 * with a button to skip anything that has no answer.
 *
 * That costs a chat something, and it is worth naming: while a question is
 * open, a plain text message is an answer rather than a journal note. Two
 * things keep that from biting. The question always arrives with a Cancel
 * button under it, and it expires on its own after half an hour
 * (`PACK_SESSION_MS`) — an abandoned question must not still be eating notes
 * the next morning.
 *
 * Everything is one screen, edited in place, in three modes: reading the list,
 * picking a line to change, picking one to remove. Adding hangs off the same
 * screen, and every answer redraws it, so the whole feature lives in a single
 * message in the chat rather than a trail of them.
 */

/** What the questions look like, in order, and what each one may be skipped to. */
const PROMPTS: Record<"title" | "model" | "url" | "category", string> = {
  title: "🎒 What is it? Send me the name — “Tent”, “Spare tube”.",
  model: "Which one exactly? Send the model, or skip it.",
  url: "A link to it? Send one, or skip it.",
  category: "Which category does it belong in? Tap one, or send a new name.",
};

const FIELD_LABEL: Record<PackField, string> = {
  title: "Name",
  model: "Model",
  url: "Link",
  category: "Category",
};

/** The heading for the things nobody filed anywhere. */
const LOOSE = "Everything else";

function cancelRow(keyboard: InlineKeyboard): InlineKeyboard {
  return keyboard.text("✖️ Cancel", encodeAction({ type: "packCancel" }));
}

/** The question currently open, as a screen. */
function promptView(step: PackSession["step"], session: PackSession, categories: string[]): View {
  const field: PackField =
    step === "edit" ? (session.field ?? "title") : (step as PackField);

  if (field === "category") {
    const keyboard = new InlineKeyboard();
    categories.forEach((category, i) => {
      keyboard.text(category, encodeAction({ type: "packCat", index: i }));
      // Two to a row: a category name is a word or two, and three of them
      // squeeze to an ellipsis on a narrow phone.
      if ((i + 1) % 2 === 0) keyboard.row();
    });
    keyboard.row().text("— No category", encodeAction({ type: "packCatNone" }));
    return {
      text: `${PROMPTS.category}${session.itemId ? "" : `\n\n_${draftSoFar(session.draft)}_`}`,
      keyboard: cancelRow(keyboard.row()),
      markdown: true,
    };
  }

  const keyboard = new InlineKeyboard();
  // The name is the one answer with nothing to fall back on: an entry with no
  // name is a blank line on the family's page.
  if (field !== "title") keyboard.text("↷ Skip", encodeAction({ type: "packSkip" }));
  return {
    text:
      step === "edit"
        ? `✏️ Send the new ${FIELD_LABEL[field].toLowerCase()}${
            field === "title" ? "" : ", or skip it to clear it"
          }.`
        : `${PROMPTS[field]}${session.draft.title ? `\n\n_${draftSoFar(session.draft)}_` : ""}`,
    keyboard: cancelRow(keyboard),
    markdown: true,
  };
}

/** What has been answered so far, under the question that follows it. */
function draftSoFar(draft: PackFields): string {
  const line = packItemLine(draft);
  return line.length > 0 ? escapeMd(line) : "";
}

/**
 * The list itself.
 *
 * Grouped by category and numbered straight through, so the number beside a
 * line and the number on its button are the same number however the groups
 * fall across pages. The categories come out in the order they first appeared
 * — see `groupByCategory` for why that beats sorting them.
 */
export async function packListView(
  trip: DbTrip,
  mode: PackMode = "view",
  page = 0,
): Promise<View> {
  const items = await listPackItems(trip.id);

  if (items.length === 0) {
    return {
      text:
        `🎒 *${escapeMd(trip.name)}* — nothing packed yet.\n\n` +
        `Tap below and I'll ask you what it is, which one, and where to find it.`,
      keyboard: new InlineKeyboard()
        .text("➕ Add something", encodeAction({ type: "packAdd" }))
        .row()
        .text("🎒 Trip", encodeAction({ type: "status" })),
      markdown: true,
    };
  }

  // Flattened with its group beside it, so paging and numbering can both work
  // on one list while the headings still land in the right places.
  const flat = groupByCategory(items).flatMap((group) =>
    group.items.map((item) => ({ item, category: group.category })),
  );
  const paged = paginate(flat, page);
  const offset = paged.page * PAGE_SIZE;

  const lines: string[] = [];
  let heading: string | null | undefined;
  paged.items.forEach((entry, i) => {
    if (heading === undefined || entry.category !== heading) {
      heading = entry.category;
      // Repeated at the top of every page: a page that opens mid-category
      // would otherwise list things under nothing at all.
      lines.push(`${lines.length > 0 ? "\n" : ""}*${escapeMd(entry.category ?? LOOSE)}*`);
    }
    const rest = [entry.item.model, entry.item.url]
      .filter((part): part is string => Boolean(part))
      .map(escapeMd)
      .join(" · ");
    lines.push(`${offset + i + 1}. ${escapeMd(entry.item.title)}${rest ? ` — ${rest}` : ""}`);
  });

  const keyboard = new InlineKeyboard();
  if (mode === "view") {
    keyboard
      .text("➕ Add", encodeAction({ type: "packAdd" }))
      .text("✏️ Change", encodeAction({ type: "packList", mode: "edit", page: paged.page }))
      .text("🗑 Remove", encodeAction({ type: "packList", mode: "del", page: paged.page }))
      .row();
  } else {
    paged.items.forEach((entry, i) => {
      const label = `${mode === "del" ? "🗑" : "✏️"} ${offset + i + 1}`;
      keyboard.text(
        label,
        mode === "del"
          ? encodeAction({ type: "packAsk", id: entry.item.id })
          : encodeAction({ type: "packPick", id: entry.item.id }),
      );
      if ((i + 1) % 4 === 0) keyboard.row();
    });
    keyboard.row().text("‹ Done", encodeAction({ type: "packList", mode: "view", page: paged.page }));
  }

  if (paged.page > 0) {
    keyboard.text("‹ Previous", encodeAction({ type: "packList", mode, page: paged.page - 1 }));
  }
  if (paged.page < paged.pageCount - 1) {
    keyboard.text("Next ›", encodeAction({ type: "packList", mode, page: paged.page + 1 }));
  }
  keyboard.row().text("🎒 Trip", encodeAction({ type: "status" }));

  const instruction =
    mode === "del"
      ? "\n\n_Tap a number to remove that line._"
      : mode === "edit"
        ? "\n\n_Tap a number to change that line._"
        : "";

  return {
    text:
      `🎒 *${escapeMd(trip.name)}* — packing list (${items.length})\n\n` +
      lines.join("\n") +
      instruction,
    keyboard,
    markdown: true,
  };
}

/** Begin the questions. The list comes back when the last one is answered. */
export async function startPackAdd(chatId: number, trip: DbTrip): Promise<View> {
  const session: PackSession = {
    tripId: trip.id,
    step: "title",
    draft: { title: "", model: null, url: null, category: null },
    itemId: null,
    field: null,
  };
  await setPackSession(chatId, session);
  return promptView("title", session, []);
}

/** Picked a line to change: which of its fields? */
export async function packFieldsView(trip: DbTrip, id: string): Promise<View | null> {
  const item = await getPackItem(trip.id, id);
  // Gone already — a button can be older than the line it points at.
  if (!item) return null;
  const keyboard = new InlineKeyboard();
  for (const field of ["title", "model", "url", "category"] as PackField[]) {
    keyboard.text(`✏️ ${FIELD_LABEL[field]}`, encodeAction({ type: "packField", field, id }));
  }
  return {
    text:
      `✏️ *${escapeMd(item.title)}*\n` +
      `${escapeMd(describe(item))}\n\n` +
      `Which part should change?`,
    keyboard: cancelRow(keyboard.row()),
    markdown: true,
  };
}

/** Everything an entry says besides its name, for a screen that quotes it back. */
function describe(item: PackItem): string {
  const parts = [
    item.model ? `Model: ${item.model}` : null,
    item.url ? `Link: ${item.url}` : null,
    `Category: ${item.category ?? LOOSE.toLowerCase()}`,
  ].filter(Boolean) as string[];
  return parts.join("\n");
}

/** Chose the field: now the bot waits for the answer. */
export async function startPackEdit(
  chatId: number,
  trip: DbTrip,
  field: PackField,
  id: string,
): Promise<View | null> {
  const item = await getPackItem(trip.id, id);
  if (!item) return null;
  const session: PackSession = {
    tripId: trip.id,
    step: "edit",
    draft: { title: item.title, model: item.model, url: item.url, category: item.category },
    itemId: id,
    field,
  };
  await setPackSession(chatId, session);
  const categories = field === "category" ? categoriesOf(await listPackItems(trip.id)) : [];
  return promptView("edit", session, categories);
}

/** The second tap before a line goes. */
export async function packConfirmView(trip: DbTrip, id: string): Promise<View | null> {
  const item = await getPackItem(trip.id, id);
  if (!item) return null;
  return {
    text: `🗑️ Take *${escapeMd(item.title)}* off the packing list?\n${escapeMd(describe(item))}`,
    keyboard: new InlineKeyboard()
      .text("🗑 Yes, remove it", encodeAction({ type: "packDel", id }))
      .row()
      .text("Cancel", encodeAction({ type: "packList", mode: "del", page: 0 })),
    markdown: true,
  };
}

/** Removed, and the list again underneath it. */
export async function packDeleteView(trip: DbTrip, id: string): Promise<View | null> {
  const item = await getPackItem(trip.id, id);
  if (!item) return null;
  await deleteEntity("pack_item", id);
  const view = await packListView(trip, "del", 0);
  return { ...view, text: `🗑️ *${escapeMd(item.title)}* removed.\n\n${view.text}` };
}

/** The chat is asked nothing again, and text goes back to being a note. */
export async function packCancelView(chatId: number, trip: DbTrip): Promise<View> {
  await clearPackSession(chatId);
  const view = await packListView(trip, "view", 0);
  return { ...view, text: `✖️ Dropped. Nothing was saved.\n\n${view.text}` };
}

/**
 * An answer to whatever is currently being asked.
 *
 * One entry point for all four shapes an answer takes — a typed message, the
 * Skip button, a category button, and "no category" — because they differ only
 * in what they put in the field, and every one of them then has to work out
 * which question comes next.
 */
export type PackAnswer =
  | { kind: "text"; text: string }
  | { kind: "skip" }
  | { kind: "category"; index: number }
  | { kind: "no-category" };

export async function packAnswer(
  chatId: number,
  trip: DbTrip,
  answer: PackAnswer,
  author: { id?: number; name?: string },
): Promise<View> {
  const session = await getPackSession(chatId);
  // Expired, cancelled, or belonging to a trip this chat has since switched
  // away from. Either way there is no question open to answer.
  if (!session || session.tripId !== trip.id) {
    const view = await packListView(trip, "view", 0);
    return { ...view, text: `That question has lapsed — start again below.\n\n${view.text}` };
  }

  const field: PackField = session.step === "edit" ? (session.field ?? "title") : session.step;
  const items = await listPackItems(trip.id);

  // What the answer amounts to, before it is decided where it goes.
  let value: string | null = null;
  if (answer.kind === "text") {
    if (field === "url") {
      value = normaliseUrl(answer.text);
      if (value === null) {
        // Re-ask rather than save a line the page would render as text: a
        // mistyped link is the one answer somebody wants a second go at.
        const view = promptView(session.step, session, []);
        return {
          ...view,
          text: `That isn't a link I can put on the page — it wants an http:// or https:// address.\n\n${view.text}`,
        };
      }
    } else {
      value = cleanField(
        answer.text,
        field === "title" ? MAX_TITLE : field === "category" ? MAX_CATEGORY : MAX_MODEL,
      );
    }
  } else if (answer.kind === "category") {
    const categories = categoriesOf(items);
    // The button was drawn from the list as it was then. If a category has gone
    // since — its last thing deleted from another device — ask again rather
    // than file this under whatever has moved into that position.
    value = categories[answer.index] ?? null;
    if (value === null) {
      const view = promptView(session.step, session, categories);
      return { ...view, text: `That category has gone. Pick another.\n\n${view.text}` };
    }
  }
  // "skip" and "no-category" both mean null, which is what `value` already is.

  if (field === "title" && value === null) {
    const view = promptView(session.step, session, []);
    return { ...view, text: `It needs a name to go on the list.\n\n${view.text}` };
  }

  // Changing one field of a line that already exists: one write, then done.
  if (session.step === "edit" && session.itemId) {
    const ok = await updatePackItem(trip.id, session.itemId, field, value);
    await clearPackSession(chatId);
    const view = await packListView(trip, "view", 0);
    return {
      ...view,
      text: ok
        ? `✏️ ${FIELD_LABEL[field]} updated.\n\n${view.text}`
        : `That line has gone — nothing was changed.\n\n${view.text}`,
    };
  }

  const draft: PackFields = { ...session.draft, [field]: value ?? (field === "title" ? "" : null) };

  const next: Record<string, PackSession["step"]> = {
    title: "model",
    model: "url",
    url: "category",
  };
  const step = next[field];
  if (step) {
    const ahead: PackSession = { ...session, step, draft };
    await setPackSession(chatId, ahead);
    return promptView(step, ahead, step === "category" ? categoriesOf(items) : []);
  }

  // The category was the last question, so the entry is complete.
  await addPackItem(trip.id, draft, author);
  await clearPackSession(chatId);
  const view = await packListView(trip, "view", 0);
  return { ...view, text: `🎒 Packed: ${escapeMd(packItemLine(draft))}\n\n${view.text}` };
}

/** Whether a plain message in this chat is an answer rather than a note. */
export async function packQuestionOpen(chatId: number): Promise<boolean> {
  return (await getPackSession(chatId)) !== null;
}
