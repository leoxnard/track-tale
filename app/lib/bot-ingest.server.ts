import type { Context } from "grammy";
import { supabase } from "./supabase.server";
import type { DbTrip } from "./db.server";
import { fetchKomootTour, parseKomootUrl } from "./komoot";
import { decimate, planPointBudget, toGeoJson, type NormalizedTrack } from "./track";
import { fetchDayWeather } from "./weather";
import { renderOgCard } from "./og.server";
import { escapeErr, escapeMd } from "./telegram-md";
import { km } from "./screens.server";
import { recordAction, undoKeyboard } from "./bot-chrome.server";
import { requireDay, requireTrip } from "./bot-access.server";
import { backfillPhotoLocations } from "./bot-photos.server";
import { transitMode, type TransitMode } from "./transport";

const MODE_ICON: Record<TransitMode, string> = { train: "🚆", ferry: "⛴️", bus: "🚌" };

/**
 * Taking in what a day is made of — a ridden track, the planned route it was
 * measured against, the weather over it, and the evening's note.
 */

/**
 * Cache a day's weather, taken at the midpoint of the route it covers.
 * Returns whether anything was stored — callers on the upload path ignore it,
 * since weather is never worth failing an upload over.
 */
export async function cacheDayWeather(
  dayId: string,
  date: string,
  points: { lat: number; lng: number }[],
): Promise<boolean> {
  if (points.length === 0) return false;
  try {
    const mid = points[Math.floor(points.length / 2)];
    const weather = await fetchDayWeather(mid.lat, mid.lng, date);
    if (!weather) return false;
    await supabase()
      .from("weather_cache")
      .upsert({ day_id: dayId, data: weather, fetched_at: new Date().toISOString() });
    return true;
  } catch {
    return false;
  }
}

export async function saveTrackSegment(
  ctx: Context,
  trip: DbTrip,
  track: NormalizedTrack,
  source: "komoot" | "gpx" | "fit",
  sourceUrl?: string,
) {
  const day = await requireDay(ctx, trip);
  if (!day) return;

  const points = decimate(track.points, 4000);
  const { data: inserted, error } = await supabase().from("track_segments").insert({
    day_id: day.id,
    geojson: toGeoJson(points),
    distance_m: track.stats.distanceM,
    duration_s: track.stats.durationS,
    moving_s: track.stats.movingS,
    elevation_up: track.stats.elevationUp,
    elevation_down: track.stats.elevationDown,
    sport: track.sport ?? null,
    name: track.name ?? null,
    source,
    source_url: sourceUrl ?? null,
    started_at: track.stats.startedAt ?? null,
  })
    .select("id")
    .single();
  if (error) throw error;

  await cacheDayWeather(day.id, day.date, points);
  // Photos uploaded before this track had nothing to match against.
  const pinned = await backfillPhotoLocations(day.id);

  const { count } = await supabase()
    .from("track_segments")
    .select("*", { count: "exact", head: true })
    .eq("day_id", day.id);

  // A leg that was travelled rather than ridden is drawn on the map hatched
  // like a railway, and left out of the ridden totals — say so, because "0 km
  // added" would otherwise look like the upload half failed.
  const mode = transitMode(track.sport);
  const parts = [
    `${mode ? MODE_ICON[mode] : "✅"} Saved to *day ${day.day_number}*${track.name ? ` — ${escapeMd(track.name)}` : ""}`,
    mode
      ? `📏 ${km(track.stats.distanceM)} km by ${mode} — on the map, not in the ridden total`
      : `📏 ${km(track.stats.distanceM)} km  ⛰️ ${Math.round(track.stats.elevationUp)} m up`,
  ];
  if ((count ?? 1) > 1) parts.push(`🧩 ${count} segments merged for this day`);
  if (pinned > 0) parts.push(`📍 ${pinned} photo(s) pinned on the map`);
  const sent = await ctx
    .reply(parts.join("\n"), {
      parse_mode: "Markdown",
      reply_markup: undoKeyboard("track_segment", inserted.id, day.day_number),
    })
    .catch(() => undefined);
  await recordAction(ctx, sent, "track_segment", inserted.id);

  // The share card shows progress, so it follows every new track.
  try {
    await renderOgCard(trip.id);
  } catch {
    // a stale card must never block an upload
  }
}

export async function savePlanSegment(ctx: Context, trip: DbTrip, track: NormalizedTrack, sourceUrl?: string) {
  if (sourceUrl) {
    // Re-sending the same planned tour replaces it instead of duplicating.
    await supabase().from("plan_segments").delete().eq("trip_id", trip.id).eq("source_url", sourceUrl);
  }
  const { count } = await supabase()
    .from("plan_segments")
    .select("*", { count: "exact", head: true })
    .eq("trip_id", trip.id);

  const { error } = await supabase().from("plan_segments").insert({
    trip_id: trip.id,
    source_url: sourceUrl ?? null,
    name: track.name ?? null,
    geojson: toGeoJson(decimate(track.points, planPointBudget(track.stats.distanceM))),
    distance_m: track.stats.distanceM,
    elevation_up: track.stats.elevationUp,
    sort_order: count ?? 0,
  });
  if (error) throw error;
  await ctx
    .reply(
      `🗺️ Plan segment saved${track.name ? ` — ${track.name}` : ""} (${km(track.stats.distanceM)} km).` +
        (sourceUrl ? " It re-syncs daily; /refreshplan to sync now." : ""),
    )
    .catch(() => {});
}

export async function ingestKomootUrl(ctx: Context, trip: DbTrip, url: string) {
  const ref = parseKomootUrl(url);
  if (!ref) {
    await ctx.reply("That looks like a Komoot link but I can't read a tour id from it.");
    return;
  }
  // Best-effort status ping — never let a failed reply block the actual import.
  await ctx.reply("⏳ Fetching tour from Komoot…").catch(() => {});
  try {
    const tour = await fetchKomootTour(ref);
    if (tour.tourType === "tour_planned") {
      await savePlanSegment(ctx, trip, tour, tour.sourceUrl);
    } else {
      await saveTrackSegment(ctx, trip, tour, "komoot", tour.sourceUrl);
    }
  } catch (err) {
    // "share\_token" is escaped deliberately: a lone underscore opens an italic
    // entity that never closes, and Telegram then drops the whole message —
    // leaving a failed import with no explanation at all.
    await ctx.reply(
      `⚠️ Komoot fetch failed (${escapeErr(err)}).\n` +
        "Make sure you sent the *share link* (with share\\_token). Fallback: export the tour as GPX and send the file.",
      { parse_mode: "Markdown" },
    );
  }
}

export async function saveNote(ctx: Context, text: string) {
  const trip = await requireTrip(ctx);
  if (!trip) return;
  const day = await requireDay(ctx, trip);
  if (!day) return;

  const { senderId, senderName } = ctx.state;
  const { data: inserted, error } = await supabase()
    .from("notes")
    .insert({
      day_id: day.id,
      text,
      author_telegram_id: senderId,
      author_name: senderName,
    })
    .select("id")
    .single();
  if (error) throw error;
  const sent = await ctx
    .reply(`📝 Noted for day ${day.day_number}.`, {
      reply_markup: undoKeyboard("note", inserted.id, day.day_number),
    })
    .catch(() => undefined);
  await recordAction(ctx, sent, "note", inserted.id);
}

/** Re-fetch every plan segment that has a Komoot source link. Returns count updated. */
export async function refreshPlan(tripId: string): Promise<number> {
  const { data: plans } = await supabase()
    .from("plan_segments")
    .select("id, source_url")
    .eq("trip_id", tripId)
    .not("source_url", "is", null);

  let updated = 0;
  for (const plan of plans ?? []) {
    const ref = parseKomootUrl(plan.source_url as string);
    if (!ref) continue;
    try {
      const tour = await fetchKomootTour(ref);
      await supabase()
        .from("plan_segments")
        .update({
          name: tour.name ?? null,
          geojson: toGeoJson(decimate(tour.points, planPointBudget(tour.stats.distanceM))),
          distance_m: tour.stats.distanceM,
          elevation_up: tour.stats.elevationUp,
        })
        .eq("id", plan.id);
      updated++;
    } catch {
      // keep the previous version of this segment
    }
  }
  return updated;
}
