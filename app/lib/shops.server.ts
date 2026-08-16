import { InlineKeyboard } from "grammy";
import { env } from "./env.server";
import { escapeMd } from "./telegram-md";
import { encodeAction } from "./manage";
import { cutPlan, DEFAULT_TARGET_KM, type PlanCut } from "./route-cut";
import { formatDistanceM } from "./track";
import { loadPlan, type Position } from "./bot-route.server";
import {
  corridorPoints,
  mapLink,
  overpassQuery,
  parseShops,
  shortHours,
  MAX_AHEAD_KM,
  NEAR_RADIUS_M,
  SHOP_ICON,
  SHOP_LIMIT,
  WIDE_RADIUS_M,
  type ShopHit,
} from "./shops";
import type { DbTrip } from "./db.server";

/**
 * Asking OpenStreetMap what the road ahead has on it.
 *
 * The corridor, the measuring and the ranking are all in `shops.ts` and tested
 * there. What is here is the request itself and the message it turns into —
 * plus the one piece of judgement that needs the answer in hand: when a tight
 * corridor comes back empty, the search is widened once and *said to have been
 * widened*, rather than reporting that there is nothing out there. A rider
 * reading "nothing in the next 50 km" needs to know whether that means nothing
 * near the route or nothing at all, because the two lead to different days.
 */

/** Overpass is a shared, donated service; a request identifies itself. */
const USER_AGENT = "TrackTale/1.0 (trip journal bot; +https://github.com/leoxnard/track-tale)";

/**
 * How long the whole search may take, both requests together.
 *
 * A budget rather than a per-request timeout, because there can be two of them:
 * the tight corridor and, when that comes back empty, the wider one. Two
 * twenty-second timeouts in a row is forty seconds inside a webhook handler
 * that a serverless platform will cut off long before then, and a cut-off
 * function tells the traveller nothing at all — the "looking…" line just sits
 * there. Overpass is given the same number as its own `timeout`, so an instance
 * is not left grinding on a query nobody is waiting for any more.
 */
const SEARCH_BUDGET_MS = 18_000;

/** Below this there is no point starting another request. */
const MIN_ATTEMPT_MS = 4_000;

export interface ShopSearch {
  shops: ShopHit[];
  /** False when the trip has no planned route to search along at all. */
  hasPlan: boolean;
  /** Metres of route searched — less than asked for near the end of a plan. */
  searchedM: number;
  radiusM: number;
  /** Whether the corridor had to be widened because the tight one was empty. */
  widened: boolean;
}

/**
 * Everything within `radiusM` of the next `aheadKm` of plan, nearest first.
 *
 * Throws only where there is nothing sensible to return — a dead Overpass, a
 * request that timed out. A valid answer with nothing in it is an answer.
 */
async function search(route: PlanCut, radiusM: number, budgetMs: number): Promise<ShopHit[]> {
  const corridor = corridorPoints(route.points, radiusM);
  if (corridor.length === 0) return [];

  const res = await fetch(env.overpassUrl, {
    method: "POST",
    headers: { "Content-Type": "text/plain", "User-Agent": USER_AGENT },
    body: overpassQuery(corridor, radiusM, budgetMs / 1000),
    signal: AbortSignal.timeout(budgetMs),
  });
  if (!res.ok) throw new Error(`Overpass answered ${res.status}`);

  // A rate-limited or overloaded instance answers 200 with HTML in it, so the
  // body is parsed defensively rather than trusted for being a 200.
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("Overpass sent something that isn't an answer — it may be rate limiting us");
  }

  return parseShops(body, route.points, radiusM, SHOP_LIMIT);
}

/**
 * The whole job: cut the road ahead, ask what is on it, and hand back what to
 * put in the chat.
 */
export async function shopsAhead(
  trip: DbTrip,
  position: { lat: number; lng: number },
  aheadKm: number,
): Promise<ShopSearch> {
  const plan = await loadPlan(trip.id);
  const km = Math.min(MAX_AHEAD_KM, Math.max(1, Math.round(aheadKm)));
  const route = cutPlan(plan, position, km * 1000);
  if (!route) {
    return { shops: [], hasPlan: false, searchedM: 0, radiusM: NEAR_RADIUS_M, widened: false };
  }

  const deadline = Date.now() + SEARCH_BUDGET_MS;
  const near = await search(route, NEAR_RADIUS_M, SEARCH_BUDGET_MS);
  const found = { shops: near, hasPlan: true, searchedM: route.cutM };
  if (near.length > 0) return { ...found, radiusM: NEAR_RADIUS_M, widened: false };

  // Nothing close by. Widening is worth a second request — but only with enough
  // of the budget left to finish one, and the answer says which radius it is
  // reporting on either way, so running out of time cannot read as "empty".
  const left = deadline - Date.now();
  if (left < MIN_ATTEMPT_MS) return { ...found, radiusM: NEAR_RADIUS_M, widened: false };

  const wide = await search(route, WIDE_RADIUS_M, left);
  return { ...found, shops: wide, radiusM: WIDE_RADIUS_M, widened: true };
}

/**
 * The list, as a message.
 *
 * Each line leads with how far along the ride the shop is, because that is what
 * is being decided: whether to stop now or in an hour. The offset comes second
 * and the name carries the map link, so the whole line stays one line on a
 * phone.
 */
export function shopsMessage(search: ShopSearch, position: Position, aheadKm: number): string {
  // A trip with no plan cannot answer this at all, and saying "nothing found"
  // would send the traveller looking for shops that were never searched for.
  if (!search.hasPlan) {
    return (
      "No plan on this trip yet, so there is no road ahead to search along. " +
      'Send the planned Komoot link, or a GPX with the caption "plan", and ' +
      "/supermarkt will work from it."
    );
  }

  const searchedKm = Math.round(search.searchedM / 1000);
  const lines: string[] = [
    `🛒 *Shops on the next ${searchedKm} km*`,
    `📍 From ${escapeMd(position.source)}`,
  ];

  if (search.shops.length === 0) {
    // Named by the radius actually searched, not by the widest one there is:
    // when the budget ran out after the tight pass, saying "nothing within
    // 1.5 km" would be a claim the search never tested.
    lines.push(
      "",
      `Nothing within ${formatDistanceM(search.radiusM)} of the route in that stretch — ` +
        `not on OpenStreetMap, at least. Try a longer look: /supermarkt ${Math.min(MAX_AHEAD_KM, aheadKm * 2)}`,
    );
    return lines.join("\n");
  }

  if (search.widened) {
    lines.push(
      "",
      `Nothing within ${formatDistanceM(NEAR_RADIUS_M)} of the route, so this is the ` +
        `wider look — up to ${formatDistanceM(WIDE_RADIUS_M)} off it.`,
    );
  }

  lines.push("");
  for (const shop of search.shops) {
    const detour = `${formatDistanceM(shop.offsetM)} off`;
    lines.push(
      `${SHOP_ICON[shop.kind]} *${formatDistanceM(shop.alongM)}* — ` +
        `[${escapeMd(shop.name)}](${mapLink(shop.lat, shop.lng)}) · ${detour}` +
        (shop.openingHours ? `\n   🕒 ${escapeMd(shortHours(shop.openingHours))}` : ""),
    );
  }

  lines.push("", "_Hours and shops as OpenStreetMap has them._");
  return lines.join("\n");
}

/**
 * Look further, or ask for the route instead.
 *
 * The position rides in the payload for the same reason the route buttons carry
 * theirs: a button that re-resolved "where are you" would answer a different
 * question from the one the message above it answered.
 */
export function shopsKeyboard(position: { lat: number; lng: number }, aheadKm: number): InlineKeyboard {
  const at = { lat: position.lat, lng: position.lng };
  const keyboard = new InlineKeyboard();
  for (const km of [25, 50, 100]) {
    keyboard.text(
      km === aheadKm ? `· ${km} km ·` : `${km} km`,
      encodeAction({ type: "shops", km, ...at }),
    );
  }
  return keyboard
    .row()
    // The route button offers an ordinary day, not the search distance: the two
    // numbers mean different things and sharing one would be a coincidence.
    .text("🗺 Route from here", encodeAction({ type: "cut", km: DEFAULT_TARGET_KM, ...at }));
}
