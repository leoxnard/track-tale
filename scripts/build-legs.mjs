#!/usr/bin/env node
/**
 * Build every leg described in scripts/legs/*.json into public/legs/*.gpx.
 *
 * The definitions are checked in and the GPX next to them, so a leg is a
 * reviewable file rather than a command someone has to remember having run —
 * and rebuilding one after OSM has been corrected is a re-run, not an
 * archaeology exercise. Overpass is the reason this is a build step at all:
 * it needs the network, which the workflow in .github/workflows/rail-gpx.yml
 * has.
 *
 *   node scripts/build-legs.mjs            # all of them
 *   node scripts/build-legs.mjs aberdeen   # only definitions matching that
 */

import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const legsDir = join(here, "legs");
const outDir = join(here, "..", "public", "legs");

const run = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(here, "rail-gpx.mjs"), ...args], {
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`rail-gpx.mjs exited with ${code}`)),
    );
  });

const filter = process.argv[2];
await mkdir(outDir, { recursive: true });

const files = (await readdir(legsDir))
  .filter((f) => f.endsWith(".json"))
  .filter((f) => !filter || f.includes(filter));
if (files.length === 0) throw new Error(`No leg definitions${filter ? ` matching ${filter}` : ""}.`);

for (const file of files) {
  const leg = JSON.parse(await readFile(join(legsDir, file), "utf8"));
  const args = [
    "--from", leg.from,
    "--to", leg.to,
    "--name", leg.name,
    "--type", leg.type ?? "train",
    "--out", join(outDir, file.replace(/\.json$/, ".gpx")),
  ];
  // Everything else is optional and only passed when the leg says so, so the
  // script's own defaults stay the single place they are written down.
  if (leg.filter) args.push("--filter", leg.filter);
  if (leg.pad) args.push("--pad", String(leg.pad));
  if (leg.maxPoints) args.push("--max-points", String(leg.maxPoints));
  if (leg.depart) args.push("--depart", leg.depart);
  if (leg.arrive) args.push("--arrive", leg.arrive);
  process.stderr.write(`\n=== ${file} → ${leg.name}\n`);
  await run(args);
}
