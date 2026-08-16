/**
 * The packing list: what was taken along, as three fields — what it is, which
 * one exactly, and where to look it up.
 *
 * The pure half. Two things live here: reading `/pack Tent | Hilleberg Anjan 2 |
 * https://…` back into fields, and writing the whole list out as the file the
 * download centre hands over.
 *
 * Splitting on `|` rather than asking three questions in a row is deliberate:
 * the bot has no conversation state worth spending on a list that is typed once
 * on a sofa before the trip, and `/newtrip Name | 2026-08-01` already taught the
 * same shape. The parts after the title are matched by what they *look* like
 * rather than by position, so `/pack Tent | https://…` — the common case, where
 * the link says the model better than a model number would — needs no empty
 * field held open in the middle for it.
 */

/** One line of the list, as it is typed and as the page shows it. */
export interface PackFields {
  title: string;
  model: string | null;
  url: string | null;
}

export type PackParse =
  | { ok: true; fields: PackFields }
  /** Nothing usable was typed — the caller answers with the usage line. */
  | { ok: false; reason: "empty" | "no-title" | "bad-url" };

/** As long as a button label, and comfortably inside what a page column wants. */
export const MAX_TITLE = 120;
export const MAX_MODEL = 160;

/**
 * A part is a link if it says so. Deliberately narrow: `http` and `https` only,
 * because whatever this ends up in — a page, a CSV opened in a spreadsheet —
 * renders it as something a reader can click, and `javascript:` is a link too.
 */
function asUrl(part: string): string | null {
  const candidate = /^www\./i.test(part) ? `https://${part}` : part;
  if (!/^https?:\/\//i.test(candidate)) return null;
  try {
    return new URL(candidate).toString();
  } catch {
    return null;
  }
}

/** Looks like it was meant as a link, whether or not it parses as one. */
function looksLikeUrl(part: string): boolean {
  return /^(https?:\/\/|www\.)/i.test(part);
}

/**
 * Read `Title | Model | Link` — in that order, but with the last two optional
 * and told apart by their shape rather than by how many bars were typed.
 */
export function parsePackItem(text: string): PackParse {
  const parts = text
    .split("|")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return { ok: false, reason: "empty" };

  const [first, ...rest] = parts;
  // A line that is nothing but a link has no title to head it, and calling the
  // URL the title would put a hundred characters of query string on the page.
  if (looksLikeUrl(first)) return { ok: false, reason: "no-title" };

  let model: string | null = null;
  let url: string | null = null;
  for (const part of rest) {
    if (looksLikeUrl(part)) {
      const parsed = asUrl(part);
      if (!parsed) return { ok: false, reason: "bad-url" };
      url ??= parsed;
      continue;
    }
    // Everything else is the model, joined rather than dropped: somebody who
    // types four bars meant all of it to arrive.
    model = model === null ? part : `${model} | ${part}`;
  }

  return {
    ok: true,
    fields: {
      title: first.slice(0, MAX_TITLE),
      model: model === null ? null : model.slice(0, MAX_MODEL),
      url,
    },
  };
}

/** One line of the list as the chat and the bot's own screens show it. */
export function packItemLine(item: PackFields): string {
  const parts = [item.title, item.model, item.url].filter(Boolean);
  return parts.join(" · ");
}

/**
 * The list as a file.
 *
 * CSV rather than a text file because the three fields *are* three columns —
 * a reader who opens this in a spreadsheet to tick things off gets what they
 * expected, and one who opens it in an editor still reads it fine. The byte
 * order mark is for Excel, which otherwise renders a German packing list in
 * whatever the machine's local code page happens to be.
 */
export function packListCsv(items: PackFields[]): string {
  const cell = (value: string | null) => {
    const text = value ?? "";
    // Quote whenever a bare cell could be misread — and double the quotes
    // inside, which is the whole of CSV's escaping.
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const rows = [
    ["Title", "Model", "Link"],
    ...items.map((i) => [i.title, i.model, i.url]),
  ];
  return `﻿${rows.map((row) => row.map(cell).join(",")).join("\r\n")}\r\n`;
}
