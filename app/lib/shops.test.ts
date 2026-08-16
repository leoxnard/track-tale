import { describe, expect, it } from "vitest";
import { haversineM, type TrackPoint } from "./track";
import {
  corridorPoints,
  overpassQuery,
  parseShops,
  shortHours,
  NEAR_RADIUS_M,
} from "./shops";

/** A straight route east along the 50th parallel, a vertex every ~1 km. */
const STEP_DEG = 0.0139; // ≈ 1 km of longitude at 50° N
const route: TrackPoint[] = Array.from({ length: 51 }, (_, i) => ({
  lat: 50,
  lng: 8 + i * STEP_DEG,
}));

/** Metres from the start of the route to vertex `i`, as the route measures it. */
function alongTo(i: number): number {
  let sum = 0;
  for (let j = 1; j <= i; j++) sum += haversineM(route[j - 1], route[j]);
  return sum;
}

/** ~1 degree of latitude is 111 km, so this is metres north of the line. */
function north(metres: number): number {
  return 50 + metres / 111_320;
}

function element(
  id: number,
  lat: number,
  lng: number,
  tags: Record<string, string>,
  type = "node",
) {
  return type === "node"
    ? { type, id, lat, lon: lng, tags }
    : { type, id, center: { lat, lon: lng }, tags };
}

describe("corridorPoints", () => {
  it("samples no coarser than the radius, so circles round the samples overlap", () => {
    // The reason this matters is in the module header: the query has to cover
    // the corridor whether Overpass reads the coordinate list as a polyline or
    // as a circle per vertex.
    const corridor = corridorPoints(route, NEAR_RADIUS_M);
    expect(corridor.length).toBeGreaterThan(route.length);
    for (let i = 1; i < corridor.length; i++) {
      expect(haversineM(corridor[i - 1], corridor[i])).toBeLessThanOrEqual(NEAR_RADIUS_M + 1);
    }
  });

  it("keeps the far end, so the last kilometres are searched too", () => {
    const corridor = corridorPoints(route, NEAR_RADIUS_M);
    expect(corridor[0]).toEqual(route[0]);
    expect(corridor[corridor.length - 1]).toEqual(route[route.length - 1]);
  });

  it("opens the spacing out rather than sending an unbounded query", () => {
    const long: TrackPoint[] = Array.from({ length: 2001 }, (_, i) => ({
      lat: 50,
      lng: 8 + i * STEP_DEG,
    }));
    expect(corridorPoints(long, NEAR_RADIUS_M).length).toBeLessThanOrEqual(252);
  });

  it("has nothing to sample from an empty route", () => {
    expect(corridorPoints([], NEAR_RADIUS_M)).toEqual([]);
  });
});

describe("overpassQuery", () => {
  const corridor = [
    { lat: 50, lng: 8 },
    { lat: 50.1, lng: 8.1 },
  ];

  it("asks for every shop kind within the radius of the corridor", () => {
    const query = overpassQuery(corridor, 300);
    expect(query).toContain("[out:json]");
    expect(query).toContain("supermarket|convenience|grocery|general");
    expect(query).toContain("(around:300,50.00000,8.00000,50.10000,8.10000)");
    // Nodes, ways and relations, with a coordinate for the ones that are shapes.
    expect(query).toContain("nwr");
  });

  it("never asks for the tags-only output, which would strip node coordinates", () => {
    // `out tags` is a verbosity level meaning "ids and tags, no geometry". It
    // reads like the leaner request and costs less, and it silently returns
    // every shop mapped as a plain node — most of them — with nowhere to put it.
    const query = overpassQuery(corridor, 300);
    expect(query).toContain("out center ");
    expect(query).not.toContain("out tags");
  });

  it("hands Overpass the same deadline the caller is holding", () => {
    expect(overpassQuery(corridor, 300, 12)).toContain("[out:json][timeout:12]");
    // Never zero or negative, whatever budget is left when it is called.
    expect(overpassQuery(corridor, 300, 0.2)).toContain("[timeout:1]");
  });
});

describe("parseShops", () => {
  it("measures each shop along and off the route", () => {
    const body = {
      elements: [
        element(1, north(80), route[12].lng, { shop: "supermarket", name: "REWE" }),
        element(2, north(150), route[4].lng, { shop: "convenience", name: "Spar" }),
      ],
    };

    const shops = parseShops(body, route, NEAR_RADIUS_M);

    // Ordered by how far along the ride they are, not how close they sit.
    expect(shops.map((s) => s.name)).toEqual(["Spar", "REWE"]);
    expect(shops[0].alongM).toBeCloseTo(alongTo(4), -2);
    expect(shops[0].offsetM).toBeCloseTo(150, -2);
    expect(shops[1].alongM).toBeCloseTo(alongTo(12), -2);
    expect(shops[1].offsetM).toBeCloseTo(80, -1);
    expect(shops[1].kind).toBe("supermarket");
  });

  it("drops what sits beyond the radius of the line itself", () => {
    // Within a circle around a sample point, but 900 m off the route: the kind
    // of hit a per-vertex reading of the query hands back, and exactly the kind
    // the message must not carry.
    const body = {
      elements: [element(1, north(900), route[10].lng, { shop: "supermarket", name: "Far" })],
    };
    expect(parseShops(body, route, NEAR_RADIUS_M)).toEqual([]);
  });

  it("takes the coordinate of a shop mapped as a building", () => {
    const body = {
      elements: [
        element(7, north(50), route[3].lng, { shop: "supermarket", name: "Edeka" }, "way"),
      ],
    };
    const shops = parseShops(body, route, NEAR_RADIUS_M);
    expect(shops).toHaveLength(1);
    expect(shops[0].id).toBe("way/7");
    expect(shops[0].lat).toBeCloseTo(north(50), 5);
  });

  it("merges a shop mapped twice, keeping the hours from whichever half has them", () => {
    const body = {
      elements: [
        element(1, north(40), route[6].lng, { shop: "supermarket", name: "Aldi" }),
        element(
          2,
          north(60),
          route[6].lng,
          { shop: "supermarket", name: "Aldi", opening_hours: "Mo-Sa 07:00-20:00" },
          "way",
        ),
      ],
    };
    const shops = parseShops(body, route, NEAR_RADIUS_M);
    expect(shops).toHaveLength(1);
    expect(shops[0].openingHours).toBe("Mo-Sa 07:00-20:00");
  });

  it("keeps two different shops standing next to each other", () => {
    const body = {
      elements: [
        element(1, north(40), route[6].lng, { shop: "supermarket", name: "Aldi" }),
        element(2, north(50), route[6].lng, { shop: "supermarket", name: "Lidl" }),
      ],
    };
    expect(parseShops(body, route, NEAR_RADIUS_M)).toHaveLength(2);
  });

  it("names an unnamed shop by what it is", () => {
    const body = {
      elements: [element(1, north(40), route[6].lng, { shop: "convenience" })],
    };
    expect(parseShops(body, route, NEAR_RADIUS_M)[0].name).toBe("Corner shop");
  });

  it("ignores anything without a coordinate, a shop tag, or a shop tag we asked for", () => {
    const body = {
      elements: [
        { type: "way", id: 9, tags: { shop: "supermarket", name: "No coordinate" } },
        element(2, north(40), route[6].lng, { name: "Not a shop" }),
        element(3, north(40), route[6].lng, { shop: "hairdresser", name: "Not food" }),
      ],
    };
    expect(parseShops(body, route, NEAR_RADIUS_M)).toEqual([]);
  });

  it("survives an answer that is not one", () => {
    // Overpass answers a rate limit or a syntax error with HTML or with an
    // empty body, and a bot that throws on that is a bot that goes quiet.
    expect(parseShops(null, route, NEAR_RADIUS_M)).toEqual([]);
    expect(parseShops({}, route, NEAR_RADIUS_M)).toEqual([]);
    expect(parseShops("<html>rate limited</html>", route, NEAR_RADIUS_M)).toEqual([]);
    expect(parseShops({ elements: [] }, [], NEAR_RADIUS_M)).toEqual([]);
  });

  it("stops at the limit rather than listing a city", () => {
    const body = {
      elements: Array.from({ length: 30 }, (_, i) =>
        element(i, north(40), route[i % 40].lng, { shop: "supermarket", name: `Shop ${i}` }),
      ),
    };
    expect(parseShops(body, route, NEAR_RADIUS_M, 5)).toHaveLength(5);
  });
});

describe("shortHours", () => {
  it("quotes what the map says", () => {
    expect(shortHours("Mo-Sa 07:00-20:00")).toBe("Mo-Sa 07:00-20:00");
    expect(shortHours("Mo-Fr 08:00-20:00;\n Sa 08:00-18:00")).toBe(
      "Mo-Fr 08:00-20:00; Sa 08:00-18:00",
    );
  });

  it("cuts a tag that would run past the line it is printed on", () => {
    const long = "Mo-Fr 07:00-20:00; Sa 07:00-18:00; Su 09:00-12:00; PH off; Dec 24 07:00-13:00";
    expect(shortHours(long).length).toBeLessThanOrEqual(44);
    expect(shortHours(long).endsWith("…")).toBe(true);
  });
});
