#!/usr/bin/env node
/**
 * Build a GPX for a leg that was travelled rather than ridden — a train, a
 * ferry, a bus — following the *real* line rather than a straight chord
 * between the two stations.
 *
 * A drawn-by-hand line across the map is wrong in an obvious way: rail bends
 * around every hill it was built around, and a family reading the page knows
 * what the countryside looks like. So the geometry comes from OpenStreetMap:
 * every railway way in a box around the two endpoints is pulled from Overpass,
 * joined into a graph at shared nodes, and the shortest path between the two
 * stations is what the train actually ran on. Sidings and yards are in that
 * graph too and cost distance like everything else, so the through line wins
 * on its own — there is no list of way ids to keep up to date.
 *
 * The file it writes carries `<type>train</type>`, which is what TrackTale
 * reads to hatch the line like a railway on the map and to keep its
 * kilometres out of what was ridden (see app/lib/transport.ts). Send the
 * result to the bot like any other GPX, on the day it belongs to.
 *
 *   node scripts/rail-gpx.mjs \
 *     --from 57.14357,-2.09694 --to 57.60955,-3.62134 \
 *     --name "Zug Aberdeen – Forres" \
 *     --depart 2026-08-11T09:32:00+01:00 --arrive 2026-08-11T11:20:00+01:00 \
 *     --out aberdeen-forres-train.gpx
 *
 * Flags: --type train|ferry|bus (default train) · --filter, an Overpass tag
 * filter for the ways to consider (default ["railway"="rail"]; a ferry leg
 * wants ["route"="ferry"]) · --pad, degrees of margin around the endpoints
 * (default 0.3) · --max-points, how much of the OSM detail to keep (default
 * 3000) · --endpoint, an Overpass mirror · --dump/--load, to keep the
 * downloaded data and re-run against it instead of hammering Overpass.
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const EARTH_RADIUS_M = 6371000;

export function haversineM(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/**
 * Overpass elements → an undirected graph keyed by node id.
 *
 * Ways meet where they share a node id, which is exactly how OSM models a
 * junction, so nothing has to be matched by proximity.
 */
export function buildGraph(elements) {
  const nodes = new Map();
  for (const el of elements) {
    if (el.type === "node") nodes.set(el.id, { lat: el.lat, lng: el.lon });
  }

  /** id → [{ to, cost }] */
  const edges = new Map();
  const link = (a, b, cost) => {
    if (!edges.has(a)) edges.set(a, []);
    edges.get(a).push({ to: b, cost });
  };

  for (const el of elements) {
    if (el.type !== "way" || !Array.isArray(el.nodes)) continue;
    for (let i = 1; i < el.nodes.length; i++) {
      const a = el.nodes[i - 1];
      const b = el.nodes[i];
      const from = nodes.get(a);
      const to = nodes.get(b);
      if (!from || !to || a === b) continue;
      const cost = haversineM(from, to);
      link(a, b, cost);
      link(b, a, cost);
    }
  }

  // Nodes that no way used are Overpass filling in geometry we never asked
  // about; dropping them keeps the nearest-node snap honest.
  for (const id of [...nodes.keys()]) if (!edges.has(id)) nodes.delete(id);
  return { nodes, edges };
}

export function nearestNode(graph, point) {
  let best = null;
  let bestM = Infinity;
  for (const [id, node] of graph.nodes) {
    const d = haversineM(point, node);
    if (d < bestM) {
      bestM = d;
      best = id;
    }
  }
  return best === null ? null : { id: best, distanceM: bestM };
}

/** Binary heap keyed by cost — the graph runs to tens of thousands of nodes. */
class Heap {
  #items = [];

  push(item) {
    const items = this.#items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent].cost <= items[i].cost) break;
      [items[parent], items[i]] = [items[i], items[parent]];
      i = parent;
    }
  }

  pop() {
    const items = this.#items;
    if (items.length === 0) return undefined;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let small = i;
        if (l < items.length && items[l].cost < items[small].cost) small = l;
        if (r < items.length && items[r].cost < items[small].cost) small = r;
        if (small === i) break;
        [items[small], items[i]] = [items[i], items[small]];
        i = small;
      }
    }
    return top;
  }

  get size() {
    return this.#items.length;
  }
}

/** Shortest path by distance, as the list of points it runs through. */
export function shortestPath(graph, fromId, toId) {
  const dist = new Map([[fromId, 0]]);
  const prev = new Map();
  const done = new Set();
  const queue = new Heap();
  queue.push({ id: fromId, cost: 0 });

  while (queue.size > 0) {
    const { id } = queue.pop();
    if (done.has(id)) continue;
    done.add(id);
    if (id === toId) break;

    for (const edge of graph.edges.get(id) ?? []) {
      if (done.has(edge.to)) continue;
      const cost = dist.get(id) + edge.cost;
      if (cost < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, cost);
        prev.set(edge.to, id);
        queue.push({ id: edge.to, cost });
      }
    }
  }

  if (!dist.has(toId)) return null;
  const ids = [toId];
  while (ids[0] !== fromId) ids.unshift(prev.get(ids[0]));
  return { points: ids.map((id) => graph.nodes.get(id)), distanceM: dist.get(toId) };
}

/**
 * OSM surveys a railway to the metre; a line on a map of Scotland does not
 * need every one of them. Thinned by an even step with both ends kept, which
 * is what the app does to a ridden track for the same reason.
 */
export function decimate(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  const step = Math.ceil(points.length / maxPoints);
  const out = points.filter((_, i) => i % step === 0);
  const last = points[points.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

function esc(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c],
  );
}

/**
 * GPX 1.1 with a `<type>`, which is where the mode of travel belongs.
 *
 * Times, when a departure and an arrival are given, are spread along the line
 * by distance covered. They are an approximation of the timetable, and they
 * earn their place: photos taken out of the window are pinned to the route by
 * their timestamp, so without them a train window ends up on the map wherever
 * the day's cycling happened to be at that minute.
 */
export function toGpx(points, { name, type = "train", departMs, arriveMs }) {
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) {
    cumulative.push(cumulative[i - 1] + haversineM(points[i - 1], points[i]));
  }
  const total = cumulative[cumulative.length - 1];
  const timed = departMs !== undefined && arriveMs !== undefined && total > 0;

  const trkpts = points
    .map((p, i) => {
      const time = timed
        ? `<time>${new Date(departMs + ((arriveMs - departMs) * cumulative[i]) / total).toISOString()}</time>`
        : "";
      return `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lng.toFixed(6)}">${time}</trkpt>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TrackTale rail-gpx" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${esc(name)}</name>
    <type>${esc(type)}</type>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>
`;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const value = argv[i + 1]?.startsWith("--") ? "true" : argv[++i];
    args[key] = value ?? "true";
  }
  return args;
}

function parsePoint(value, label) {
  const [lat, lng] = String(value ?? "").split(",").map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error(`--${label} needs "lat,lng" (got ${value ?? "nothing"})`);
  }
  return { lat, lng };
}

function parseTime(value, label) {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`--${label} is not a date I can read: ${value}`);
  return ms;
}

async function main(argv) {
  const args = parseArgs(argv);
  const from = parsePoint(args.from, "from");
  const to = parsePoint(args.to, "to");
  const pad = Number(args.pad ?? 0.3);
  const filter = args.filter ?? '["railway"="rail"]';
  const endpoint = args.endpoint ?? "https://overpass-api.de/api/interpreter";
  const out = args.out ?? "leg.gpx";

  let elements;
  if (args.load) {
    elements = JSON.parse(await readFile(args.load, "utf8")).elements;
  } else {
    const bbox = [
      Math.min(from.lat, to.lat) - pad,
      Math.min(from.lng, to.lng) - pad,
      Math.max(from.lat, to.lat) + pad,
      Math.max(from.lng, to.lng) + pad,
    ].join(",");
    const query = `[out:json][timeout:300];way${filter}(${bbox});(._;>;);out body;`;
    process.stderr.write(`Asking Overpass for ${filter} in ${bbox}…\n`);
    const res = await fetch(endpoint, { method: "POST", body: `data=${encodeURIComponent(query)}` });
    if (!res.ok) throw new Error(`Overpass answered ${res.status}: ${await res.text()}`);
    const body = await res.text();
    if (args.dump) await writeFile(args.dump, body);
    elements = JSON.parse(body).elements;
  }

  const graph = buildGraph(elements ?? []);
  process.stderr.write(`${graph.nodes.size} nodes in the network.\n`);

  const start = nearestNode(graph, from);
  const end = nearestNode(graph, to);
  if (!start || !end) throw new Error("No usable network in that box — widen --pad or check --filter.");
  for (const [label, snap] of [["from", start], ["to", end]]) {
    process.stderr.write(`--${label} snapped ${snap.distanceM.toFixed(0)} m onto the line.\n`);
    // Far enough off and the snap has found some unrelated stretch of track.
    if (snap.distanceM > 2000) process.stderr.write(`  ⚠️  that is a long way — check the coordinates.\n`);
  }

  const path = shortestPath(graph, start.id, end.id);
  if (!path) throw new Error("The two ends are not connected in this data — widen --pad.");

  const points = decimate(path.points, Number(args["max-points"] ?? 3000));
  const gpx = toGpx(points, {
    name: args.name ?? "Travelled leg",
    type: args.type ?? "train",
    departMs: parseTime(args.depart, "depart"),
    arriveMs: parseTime(args.arrive, "arrive"),
  });
  await writeFile(out, gpx);
  process.stderr.write(
    `Wrote ${out}: ${points.length} of ${path.points.length} points, ` +
      `${(path.distanceM / 1000).toFixed(1)} km along the line.\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}
