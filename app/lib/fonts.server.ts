/**
 * The embedded fonts, on disk.
 *
 * resvg loads fonts from files only, so they are materialised into a temp
 * directory once per process. This keeps everything rendered server-side —
 * share card, trip logo — identical on Vercel, on a self-hosted box, and
 * locally, without depending on what the bundler ships or what the host has
 * installed.
 */

import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ATKINSON_BOLD_B64, ATKINSON_REGULAR_B64 } from "./fonts";

export const DEFAULT_FONT_FAMILY = "Atkinson Hyperlegible";

let fontFiles: string[] | undefined;

/** Paths to the font files, written on first use. */
export function fontPaths(): string[] {
  if (fontFiles && fontFiles.every(existsSync)) return fontFiles;
  const dir = mkdtempSync(join(tmpdir(), "tracktale-fonts-"));
  const write = (name: string, b64: string) => {
    const path = join(dir, name);
    writeFileSync(path, Buffer.from(b64, "base64"));
    return path;
  };
  fontFiles = [
    write("atkinson-regular.ttf", ATKINSON_REGULAR_B64),
    write("atkinson-bold.ttf", ATKINSON_BOLD_B64),
  ];
  return fontFiles;
}

/** The `font` block resvg wants, in the one shape every renderer here uses. */
export function resvgFont() {
  return {
    loadSystemFonts: false,
    fontFiles: fontPaths(),
    defaultFontFamily: DEFAULT_FONT_FAMILY,
  };
}
