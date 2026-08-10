import { describe, expect, it } from "vitest";
import { buildGraph, haversineM, nearestNode, shortestPath, toGpx } from "./rail-gpx.mjs";

/**
 * A miniature network with a decoy: the through line runs 1 → 2 → 3 → 4, and a
 * siding hangs off node 2. Nothing tells the path finder which is which, so if
 * it comes back with the through line it did so on distance alone — which is
 * the whole reason there is no hand-kept list of way ids in the script.
 */
const network = {
  elements: [
    { type: "node", id: 1, lat: 57.0, lon: -2.0 },
    { type: "node", id: 2, lat: 57.1, lon: -2.2 },
    { type: "node", id: 3, lat: 57.2, lon: -2.5 },
    { type: "node", id: 4, lat: 57.3, lon: -2.9 },
    { type: "node", id: 9, lat: 57.05, lon: -2.35 },
    // The through line, in two ways that meet at node 3 — as a real line is
    // split in OSM wherever a tag changes.
    { type: "way", id: 100, nodes: [1, 2, 3] },
    { type: "way", id: 101, nodes: [3, 4] },
    // The siding.
    { type: "way", id: 102, nodes: [2, 9] },
  ],
};

describe("buildGraph", () => {
  it("joins ways at the nodes they share, both ways round", () => {
    const graph = buildGraph(network.elements);
    expect(graph.nodes.size).toBe(5);
    expect(graph.edges.get(3).map((e) => e.to).sort()).toEqual([2, 4]);
    // Undirected: the way listed 3 before 4, and 4 still knows about 3.
    expect(graph.edges.get(4).map((e) => e.to)).toEqual([3]);
  });

  it("drops nodes no way used", () => {
    const graph = buildGraph([
      ...network.elements,
      { type: "node", id: 77, lat: 57.4, lon: -3.5 },
    ]);
    expect(graph.nodes.has(77)).toBe(false);
  });
});

describe("nearestNode", () => {
  it("snaps a station coordinate onto the line and says how far it moved", () => {
    const graph = buildGraph(network.elements);
    const snap = nearestNode(graph, { lat: 57.301, lng: -2.902 });
    expect(snap.id).toBe(4);
    expect(snap.distanceM).toBeLessThan(200);
  });
});

describe("shortestPath", () => {
  it("follows the through line rather than wandering down the siding", () => {
    const graph = buildGraph(network.elements);
    const path = shortestPath(graph, 1, 4);
    expect(path.points.map((p) => p.lng)).toEqual([-2.0, -2.2, -2.5, -2.9]);
    // The distance is the line's own, summed leg by leg — not the crow-flight
    // between the two ends, which is what a straight GPX would have given.
    const alongTheLine = path.points
      .slice(1)
      .reduce((sum, p, i) => sum + haversineM(path.points[i], p), 0);
    expect(path.distanceM).toBeCloseTo(alongTheLine, 6);
    expect(path.distanceM).toBeGreaterThan(haversineM(path.points[0], path.points[3]));
  });

  it("returns null when the two ends are in unconnected pieces", () => {
    const graph = buildGraph([
      { type: "node", id: 1, lat: 57, lon: -2 },
      { type: "node", id: 2, lat: 57.1, lon: -2.1 },
      { type: "node", id: 3, lat: 58, lon: -4 },
      { type: "node", id: 4, lat: 58.1, lon: -4.1 },
      { type: "way", id: 1, nodes: [1, 2] },
      { type: "way", id: 2, nodes: [3, 4] },
    ]);
    expect(shortestPath(graph, 1, 4)).toBeNull();
  });
});

describe("toGpx", () => {
  const points = [
    { lat: 57.0, lng: -2.0 },
    { lat: 57.1, lng: -2.2 },
    { lat: 57.2, lng: -2.5 },
  ];

  it("writes the mode into <type>, which is what marks the leg as travelled", () => {
    const gpx = toGpx(points, { name: "Zug Aberdeen – Forres", type: "train" });
    expect(gpx).toContain("<type>train</type>");
    expect(gpx).toContain("<name>Zug Aberdeen – Forres</name>");
    expect(gpx.match(/<trkpt /g)).toHaveLength(3);
    expect(gpx).toContain('<trkpt lat="57.100000" lon="-2.200000">');
  });

  it("spreads the timetable along the line by distance, not by point count", () => {
    const depart = Date.parse("2026-08-11T09:00:00Z");
    const arrive = Date.parse("2026-08-11T11:00:00Z");
    const times = [...toGpx(points, { name: "leg", departMs: depart, arriveMs: arrive }).matchAll(/<time>(.+?)<\/time>/g)]
      .map((match) => Date.parse(match[1]));

    expect(times[0]).toBe(depart);
    expect(times[2]).toBe(arrive);
    // The second leg is the longer one, so the middle point is passed before
    // half the journey time has gone.
    expect(times[1]).toBeGreaterThan(depart);
    expect(times[1]).toBeLessThan(depart + (arrive - depart) / 2);
  });

  it("leaves the times out when there is no timetable to spread", () => {
    expect(toGpx(points, { name: "leg" })).not.toContain("<time>");
  });
});
