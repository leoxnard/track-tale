/**
 * The packing list: what was taken along, filed under Camping, Bike or whatever
 * else the traveller thinks in.
 *
 * The pure half — the parts worth having without a database or a chat in the
 * way: what counts as a link, how the list is grouped, and how it is written
 * out as a file.
 *
 * There is deliberately no syntax to learn. An earlier version took the whole
 * entry on one line with bars between the fields, and typing
 * `/pack Tent | Hilleberg Anjan 2 | https://…` on a phone, in a tent, is
 * precisely the kind of thing nobody does twice. The bot asks instead, one
 * short message at a time, which is why the parsing that used to live here is
 * gone and only the link check is left.
 */

/** One line of the list, as it is entered and as the page shows it. */
export interface PackFields {
  title: string;
  model: string | null;
  url: string | null;
  /** Camping, Bike, Kitchen… — the traveller's own words, or nothing. */
  category: string | null;
}

/** As long as a button label, and comfortably inside what a page column wants. */
export const MAX_TITLE = 120;
export const MAX_MODEL = 160;
export const MAX_CATEGORY = 40;

/**
 * A typed line as a link, or null if it is not one.
 *
 * Deliberately narrow: `http` and `https` only, because whatever this ends up
 * in — a page, a CSV opened in a spreadsheet — renders it as something a reader
 * can click, and `javascript:` is a link too. A bare `www.` is the one thing
 * mended rather than refused, since that is how half the world types an address.
 */
export function normaliseUrl(text: string): string | null {
  const trimmed = text.trim();
  const candidate = /^www\./i.test(trimmed) ? `https://${trimmed}` : trimmed;
  if (!/^https?:\/\//i.test(candidate)) return null;
  try {
    const url = new URL(candidate);
    // A scheme and nothing else parses fine and leads nowhere.
    return url.hostname.length > 0 ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Trim a typed answer to what a column can hold, or null if it holds nothing. */
export function cleanField(text: string, max: number): string | null {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length === 0 ? null : flat.slice(0, max);
}

/** One line of the list as the chat shows it, without its category. */
export function packItemLine(item: PackFields): string {
  return [item.title, item.model, item.url].filter(Boolean).join(" · ");
}

export interface PackGroup<T> {
  /** Null for the things nobody filed anywhere. */
  category: string | null;
  items: T[];
}

/**
 * The list in groups, in the order the categories first appeared.
 *
 * Not alphabetical, and not the order the categories were invented in either:
 * a list is written the way it is carried, and the group a traveller started
 * with belongs at the top of their list rather than under "Bike" because B
 * comes first. The unfiled things go last as a group of their own — they are
 * the leftovers, and putting them anywhere else would imply an order they
 * haven't got.
 */
export function groupByCategory<T extends { category: string | null }>(
  items: T[],
): PackGroup<T>[] {
  const groups: PackGroup<T>[] = [];
  const byName = new Map<string, PackGroup<T>>();
  const loose: T[] = [];

  for (const item of items) {
    if (item.category === null) {
      loose.push(item);
      continue;
    }
    let group = byName.get(item.category);
    if (!group) {
      group = { category: item.category, items: [] };
      byName.set(item.category, group);
      groups.push(group);
    }
    group.items.push(item);
  }

  if (loose.length > 0) groups.push({ category: null, items: loose });
  return groups;
}

/** Every category in use, in the same order the groups come out in. */
export function categoriesOf(items: { category: string | null }[]): string[] {
  return groupByCategory(items)
    .map((g) => g.category)
    .filter((c): c is string => c !== null);
}

/**
 * The list as a file.
 *
 * CSV rather than a text file because the fields *are* columns — a reader who
 * opens this in a spreadsheet to tick things off gets what they expected, and
 * one who opens it in an editor still reads it fine. The byte order mark is for
 * Excel, which otherwise renders a German packing list in whatever the
 * machine's local code page happens to be.
 *
 * Grouped, like everywhere else, so the file matches the page it came from.
 */
export function packListCsv(items: PackFields[]): string {
  const cell = (value: string | null) => {
    const text = value ?? "";
    // Quote whenever a bare cell could be misread — and double the quotes
    // inside, which is the whole of CSV's escaping.
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const rows: (string | null)[][] = [["Category", "Title", "Model", "Link"]];
  for (const group of groupByCategory(items)) {
    for (const item of group.items) {
      rows.push([group.category, item.title, item.model, item.url]);
    }
  }
  return `﻿${rows.map((row) => row.map(cell).join(",")).join("\r\n")}\r\n`;
}
