import { haversineM, type TrackPoint } from "./track";
import { buildPlanIndex } from "./plan-anchor";

/**
 * Shops on the road ahead: what is open along the next stretch of the plan,
 * rather than what is near a point.
 *
 * "Where is the nearest supermarket" is the wrong question on a tour, and every
 * map app answers that one. The nearest one is regularly behind you, or eight
 * kilometres up a valley you are not riding into. The question that matters is
 * *which shops the route passes*, in the order it passes them, and how far off
 * the line each one sits — a hundred metres is a stop, two kilometres is a
 * detour with a climb back out of it.
 *
 * So the search is a corridor, not a circle: OpenStreetMap is asked for shops
 * within a fixed distance of the polyline the route will follow, and every hit
 * is then measured back against that same polyline for two numbers — how far
 * along the ride it is, and how far off it. Both go in the message, because
 * "REWE, 12 km, 80 m off" is a decision and "REWE, 12 km away" is not.
 *
 * OpenStreetMap through Overpass rather than a commercial places API, and not
 * only because it needs no key: Overpass takes the corridor query natively
 * (`around` accepts a polyline), where a places API offers a radius around a
 * point and would have to be called once per sample and de-duplicated
 * afterwards. What OSM gives up is currency of opening hours — the tag is
 * usually there and usually right, but nobody guarantees it, so it is quoted as
 * what the map says rather than presented as fact.
 */

/** What counts as somewhere to buy food. */
export const SHOP_KINDS = ["supermarket", "convenience", "grocery", "general"] as const;
export type ShopKind = (typeof SHOP_KINDS)[number];

/**
 * How far off the line a shop may be and still count.
 *
 * Deliberately tight. A supermarket 300 m off the route is a five-minute stop;
 * one two kilometres off is a different ride, and a list padded with those is
 * one you stop reading. `WIDE_RADIUS_M` is only ever used as a second attempt
 * when the first found nothing at all, and the message says so when it does.
 */
export const NEAR_RADIUS_M = 300;
export const WIDE_RADIUS_M = 1500;

/** How much route a search looks along unless told otherwise. */
export const DEFAULT_AHEAD_KM = 50;
export const MAX_AHEAD_KM = 200;

/** Shops listed. Past this it stops being a list and becomes a directory. */
export const SHOP_LIMIT = 8;

/**
 * The most vertices a corridor is described with.
 *
 * Overpass reads `around` with a coordinate list as a polyline, so in principle
 * two points would do. The spacing below is chosen so that the query still
 * covers the corridor if an instance treats the list as circles around each
 * vertex instead — see `corridorPoints`.
 */
const MAX_CORRIDOR_POINTS = 250;

export interface ShopHit {
  /** Overpass element identity, e.g. "node/1234" — used only to de-duplicate. */
  id: string;
  kind: ShopKind;
  name: string;
  lat: number;
  lng: number;
  /** Metres along the route from where the rider is now. */
  alongM: number;
  /** Metres from the route line. */
  offsetM: number;
  /** The `opening_hours` tag, verbatim. OSM's syntax, not ours. */
  openingHours?: string;
}

/**
 * Sample the route into the coordinate list the corridor query is built from.
 *
 * Spacing is the search radius rather than something finer, and that is the
 * whole trick: circles of radius r centred every r along a line overlap, so the
 * query covers the corridor continuously *even if* the `around` list is read as
 * a set of circles rather than as a polyline. It costs nothing when it is read
 * as a polyline, and it removes the need to care which.
 *
 * A long search on a tight radius would run past what one query should carry,
 * so the spacing opens up when the point budget is reached — at which point the
 * polyline reading is doing the work, which is the reading Overpass documents.
 */
export function corridorPoints(route: TrackPoint[], radiusM: number): TrackPoint[] {
  if (route.length === 0) return [];

  let walked = 0;
  for (let i = 1; i < route.length; i++) walked += haversineM(route[i - 1], route[i]);
  const spacing = Math.max(radiusM, walked / MAX_CORRIDOR_POINTS);

  // Sampled *along* the line rather than picked from its vertices: a plan
  // imported before routes were stored at a point every hundred metres can run
  // a kilometre or more between vertices, and taking those as the samples would
  // quietly leave gaps in the corridor the width of the spacing.
  const sampled: TrackPoint[] = [route[0]];
  let since = 0;
  for (let i = 1; i < route.length; i++) {
    const step = haversineM(route[i - 1], route[i]);
    if (step === 0) continue;
    let cut = spacing - since;
    while (cut <= step) {
      const t = cut / step;
      sampled.push({
        lat: route[i - 1].lat + (route[i].lat - route[i - 1].lat) * t,
        lng: route[i - 1].lng + (route[i].lng - route[i - 1].lng) * t,
      });
      cut += spacing;
    }
    since = step - (cut - spacing);
  }
  // The far end always goes in: dropping it would leave the last few
  // kilometres of the ride unsearched, which is exactly where the shop you
  // were hoping for is.
  const last = route[route.length - 1];
  if (sampled[sampled.length - 1] !== last) sampled.push(last);
  return sampled;
}

/**
 * The Overpass QL for one corridor.
 *
 * `nwr` because a supermarket is as often a building outline or a
 * multipolygon as it is a point, and `out center` so those come back with a
 * coordinate instead of a member list we would have to assemble ourselves.
 */
export function overpassQuery(corridor: TrackPoint[], radiusM: number, limit = 60): string {
  const coords = corridor.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join(",");
  const kinds = SHOP_KINDS.join("|");
  return [
    "[out:json][timeout:25];",
    `nwr["shop"~"^(${kinds})$"](around:${Math.round(radiusM)},${coords});`,
    `out center tags ${limit};`,
  ].join("\n");
}

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/** Two hits this close together with the same name are one shop, mapped twice. */
const SAME_SHOP_M = 60;

/**
 * Turn an Overpass answer into the list the message is written from.
 *
 * Measuring every hit against the route again, rather than trusting that
 * Overpass returned it because it was close, is what produces the "80 m off"
 * in the message — and it is also the filter: an instance reading the `around`
 * list as circles hands back things up to a radius beyond the *line*, and those
 * are exactly the ones worth dropping.
 */
export function parseShops(
  body: unknown,
  route: TrackPoint[],
  radiusM: number,
  limit = SHOP_LIMIT,
): ShopHit[] {
  const elements = (body as { elements?: OverpassElement[] })?.elements;
  if (!Array.isArray(elements) || route.length === 0) return [];

  const index = buildPlanIndex(route);
  const hits: ShopHit[] = [];

  for (const element of elements) {
    const lat = element.lat ?? element.center?.lat;
    const lng = element.lon ?? element.center?.lon;
    const shop = element.tags?.shop;
    if (lat == null || lng == null || !shop) continue;
    if (!SHOP_KINDS.includes(shop as ShopKind)) continue;

    const anchor = index.anchor({ lat, lng });
    if (!anchor || anchor.gap > radiusM) continue;

    hits.push({
      id: `${element.type}/${element.id}`,
      kind: shop as ShopKind,
      // An unnamed shop is still a shop; calling it by its kind beats hiding it.
      name: element.tags?.name ?? element.tags?.brand ?? kindNoun(shop as ShopKind),
      lat,
      lng,
      alongM: anchor.d,
      offsetM: anchor.gap,
      ...(element.tags?.opening_hours ? { openingHours: element.tags.opening_hours } : {}),
    });
  }

  hits.sort((a, b) => a.alongM - b.alongM);

  // The same shop mapped as both a node and a building is one stop, and the
  // building is usually the one with the opening hours on it — so a duplicate
  // merges rather than being dropped.
  const merged: ShopHit[] = [];
  for (const hit of hits) {
    const twin = merged.find(
      (m) => m.name === hit.name && haversineM(m, { lat: hit.lat, lng: hit.lng }) <= SAME_SHOP_M,
    );
    if (twin) {
      if (!twin.openingHours && hit.openingHours) twin.openingHours = hit.openingHours;
      continue;
    }
    merged.push(hit);
    if (merged.length === limit) break;
  }
  return merged;
}

export const SHOP_ICON: Record<ShopKind, string> = {
  supermarket: "🛒",
  convenience: "🏪",
  grocery: "🥬",
  general: "🧺",
};

function kindNoun(kind: ShopKind): string {
  return kind === "convenience" ? "Corner shop" : kind === "general" ? "General store" : "Shop";
}

/** A link every phone opens, whichever map app it prefers. */
export function mapLink(lat: number, lng: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(5)},${lng.toFixed(5)}`;
}

export function formatAlong(m: number): string {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}

export function formatOffset(m: number): string {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}

/**
 * Opening hours are quoted, not interpreted.
 *
 * OSM's `opening_hours` is a small language — "Mo-Sa 07:00-20:00; PH off",
 * holidays, seasons, sunset — and answering "is it open now" properly means
 * implementing it, in the traveller's timezone, against a tag nobody
 * guarantees. Quoting it says exactly as much as the map knows, and a rider
 * reading "Mo-Sa 07:00-20:00" on a Sunday has their answer anyway.
 */
export function shortHours(hours: string, max = 44): string {
  const flat = hours.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}
