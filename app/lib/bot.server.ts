import { Bot, type Context } from "grammy";
import { nanoid } from "nanoid";
import { env } from "./env.server";
import { supabase } from "./supabase.server";
import {
  createInvite,
  createTrip,
  createUser,
  ensureDay,
  getTrip,
  getUser,
  listTrips,
  redeemInvite,
  setActiveTrip,
  tripDayCount,
  updateTrip,
  type DbTrip,
  type DbUser,
} from "./db.server";
import { fetchKomootTour, findKomootUrl, parseKomootUrl } from "./komoot";
import { parseFit, parseGpx } from "./gpx";
import { decimate, fromGeoJson, toGeoJson, type NormalizedTrack, type TrackGeoJson } from "./track";
import { matchPhotoToTrack } from "./photo-match";
import { fetchDayWeather } from "./weather";

const LIVETRACK_RE = /https?:\/\/(?:livetrack\.garmin\.com|[a-z]+\.garmin\.com\/livetrack)[^\s]*/i;

const HELP = `🚴 *TrackTale* — your trip journal

*Trip setup*
/newtrip Name | 2026-08-01 | 2026-08-10
/trips — list your trips
/usetrip 2 — switch active trip
/day 3 — set the day uploads go to
/trip — status + family link
/regeneratelink — new family link

*During the trip* (everything goes to the current /day)
• Send a Komoot share link → route is imported
• Send a GPX or FIT file → route is imported (several merge into one day)
• Send photos (with captions) → day gallery, pinned on the map
• Send text → journal note
• Send a Garmin LiveTrack link → 🔴 live banner for 24h

*Plan*
• Send a *planned* Komoot tour link → becomes the grey plan line
• Attach GPX with caption "plan" → same
/refreshplan — re-fetch plan links after editing in Komoot

/invite — create an invite code for a friend`;

async function resolveUser(ctx: Context): Promise<DbUser | null> {
  const from = ctx.from;
  if (!from) return null;
  const existing = await getUser(from.id);
  if (existing) return existing;

  if (from.id === env.ownerTelegramId) {
    return createUser(from.id, from.first_name ?? "Owner", true);
  }

  // Unknown user: only an invite code gets them in.
  const text = ctx.message?.text?.trim() ?? "";
  const codeMatch = text.match(/^(?:\/start\s+)?([A-Za-z0-9_-]{8,21})$/);
  if (codeMatch && (await redeemInvite(codeMatch[1], from.id))) {
    const user = await createUser(from.id, from.first_name ?? "Friend", false);
    await ctx.reply("✅ Welcome to TrackTale! Send /help to see how it works.");
    return user;
  }
  return null;
}

async function requireTrip(ctx: Context, user: DbUser): Promise<DbTrip | null> {
  if (!user.active_trip_id) {
    await ctx.reply("No active trip. Create one first:\n/newtrip Name | 2026-08-01 | 2026-08-10");
    return null;
  }
  const trip = await getTrip(user.active_trip_id);
  if (!trip) {
    await ctx.reply("Your active trip no longer exists. /newtrip to create one.");
    return null;
  }
  return trip;
}

async function requireDay(ctx: Context, trip: DbTrip) {
  if (!trip.current_day_number) {
    await ctx.reply("Which day is this? Set it first, e.g. /day 1");
    return null;
  }
  return ensureDay(trip, trip.current_day_number);
}

function tripLink(trip: DbTrip): string {
  return `${env.appOrigin}/t/${trip.share_slug}`;
}

function km(m: number): string {
  return (m / 1000).toFixed(1);
}

async function saveTrackSegment(
  ctx: Context,
  trip: DbTrip,
  track: NormalizedTrack,
  source: "komoot" | "gpx" | "fit",
  sourceUrl?: string,
) {
  const day = await requireDay(ctx, trip);
  if (!day) return;

  const points = decimate(track.points, 4000);
  const { error } = await supabase().from("track_segments").insert({
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
  });
  if (error) throw error;

  // Cache weather for the day at the track midpoint (best effort).
  try {
    const mid = points[Math.floor(points.length / 2)];
    const weather = await fetchDayWeather(mid.lat, mid.lng, day.date);
    if (weather) {
      await supabase()
        .from("weather_cache")
        .upsert({ day_id: day.id, data: weather, fetched_at: new Date().toISOString() });
    }
  } catch {
    // never fail an upload over weather
  }

  const { count } = await supabase()
    .from("track_segments")
    .select("*", { count: "exact", head: true })
    .eq("day_id", day.id);

  const parts = [
    `✅ Saved to *day ${day.day_number}*${track.name ? ` — ${track.name}` : ""}`,
    `📏 ${km(track.stats.distanceM)} km  ⛰️ ${Math.round(track.stats.elevationUp)} m up`,
  ];
  if ((count ?? 1) > 1) parts.push(`🧩 ${count} segments merged for this day`);
  await ctx.reply(parts.join("\n"), { parse_mode: "Markdown" });
}

async function savePlanSegment(ctx: Context, trip: DbTrip, track: NormalizedTrack, sourceUrl?: string) {
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
    geojson: toGeoJson(decimate(track.points, 4000)),
    distance_m: track.stats.distanceM,
    elevation_up: track.stats.elevationUp,
    sort_order: count ?? 0,
  });
  if (error) throw error;
  await ctx.reply(
    `🗺️ Plan segment saved${track.name ? ` — ${track.name}` : ""} (${km(track.stats.distanceM)} km).` +
      (sourceUrl ? " It re-syncs daily; /refreshplan to sync now." : ""),
  );
}

async function ingestKomootUrl(ctx: Context, trip: DbTrip, url: string) {
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
    await ctx.reply(
      `⚠️ Komoot fetch failed (${err instanceof Error ? err.message : "unknown error"}).\n` +
        "Make sure you sent the *share link* (with share_token). Fallback: export the tour as GPX and send the file.",
      { parse_mode: "Markdown" },
    );
  }
}

async function downloadTelegramFile(bot: Bot, fileId: string): Promise<ArrayBuffer> {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) throw new Error("Telegram returned no file path");
  const res = await fetch(`https://api.telegram.org/file/bot${env.telegramBotToken}/${file.file_path}`);
  if (!res.ok) throw new Error(`Telegram file download failed: ${res.status}`);
  return res.arrayBuffer();
}

export function createBot(): Bot {
  const bot = new Bot(env.telegramBotToken);

  // Gate every update on the allowlist.
  bot.use(async (ctx, next) => {
    const user = await resolveUser(ctx);
    if (!user) {
      if (ctx.message) {
        await ctx.reply("🔒 This is a private bot. Ask the owner for an invite code and send it here.");
      }
      return;
    }
    ctx.state = { user };
    await next();
  });

  bot.command("start", (ctx) => ctx.reply(HELP, { parse_mode: "Markdown" }));
  bot.command("help", (ctx) => ctx.reply(HELP, { parse_mode: "Markdown" }));

  bot.command("newtrip", async (ctx) => {
    const user = ctx.state.user as DbUser;
    const parts = (ctx.match as string).split("|").map((s) => s.trim());
    const [name, start, end] = parts;
    if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(start ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(end ?? "")) {
      await ctx.reply("Format: /newtrip Name | 2026-08-01 | 2026-08-10");
      return;
    }
    if (Date.parse(end) < Date.parse(start)) {
      await ctx.reply("End date is before start date.");
      return;
    }
    const trip = await createTrip({
      owner_telegram_id: user.telegram_id,
      name,
      start_date: start,
      end_date: end,
      share_slug: nanoid(16),
    });
    await ctx.reply(
      `🎒 Trip *${name}* created (${tripDayCount(trip)} days) and set active.\n\n` +
        `👨‍👩‍👧 Family link:\n${tripLink(trip)}\n\n` +
        `Next: /day 1, then send tracks. Optional: send planned Komoot links for the grey plan line.`,
      { parse_mode: "Markdown" },
    );
  });

  bot.command("trips", async (ctx) => {
    const user = ctx.state.user as DbUser;
    const trips = await listTrips(user.telegram_id);
    if (trips.length === 0) {
      await ctx.reply("No trips yet. /newtrip Name | 2026-08-01 | 2026-08-10");
      return;
    }
    const lines = trips.map(
      (t, i) =>
        `${i + 1}. ${t.name} (${t.start_date} → ${t.end_date})${t.id === user.active_trip_id ? " ✅ active" : ""}`,
    );
    await ctx.reply(lines.join("\n") + "\n\nSwitch with /usetrip <number>");
  });

  bot.command("usetrip", async (ctx) => {
    const user = ctx.state.user as DbUser;
    const trips = await listTrips(user.telegram_id);
    const idx = parseInt((ctx.match as string).trim(), 10) - 1;
    const trip = trips[idx];
    if (!trip) {
      await ctx.reply("Usage: /usetrip <number from /trips>");
      return;
    }
    await setActiveTrip(user.telegram_id, trip.id);
    await ctx.reply(`✅ Active trip: ${trip.name}`);
  });

  bot.command("day", async (ctx) => {
    const user = ctx.state.user as DbUser;
    const trip = await requireTrip(ctx, user);
    if (!trip) return;
    const n = parseInt((ctx.match as string).trim(), 10);
    const max = tripDayCount(trip);
    if (!Number.isInteger(n) || n < 1 || n > max) {
      await ctx.reply(`Usage: /day <1–${max}>`);
      return;
    }
    const day = await ensureDay(trip, n);
    await updateTrip(trip.id, { current_day_number: n });
    await ctx.reply(`📅 Day ${n} (${day.date}) is now current — uploads land here.`);
  });

  bot.command("trip", async (ctx) => {
    const user = ctx.state.user as DbUser;
    const trip = await requireTrip(ctx, user);
    if (!trip) return;
    const { data: days } = await supabase()
      .from("days")
      .select("id, day_number, track_segments(distance_m, elevation_up)")
      .eq("trip_id", trip.id);
    let totalKm = 0;
    let totalUp = 0;
    let daysWithTracks = 0;
    for (const d of days ?? []) {
      const segs = (d as { track_segments: { distance_m: number; elevation_up: number }[] }).track_segments;
      if (segs.length > 0) daysWithTracks++;
      for (const s of segs) {
        totalKm += s.distance_m;
        totalUp += s.elevation_up;
      }
    }
    const { data: plans } = await supabase()
      .from("plan_segments")
      .select("distance_m")
      .eq("trip_id", trip.id);
    const planKm = (plans ?? []).reduce((sum, p) => sum + p.distance_m, 0);
    const progress = planKm > 0 ? ` (${Math.min(100, Math.round((totalKm / planKm) * 100))}% of plan)` : "";

    await ctx.reply(
      `🎒 *${trip.name}* — ${trip.start_date} → ${trip.end_date}\n` +
        `📅 Current day: ${trip.current_day_number ?? "not set"}\n` +
        `📏 ${km(totalKm)} km over ${daysWithTracks} tracked days${progress}\n` +
        `👨‍👩‍👧 ${tripLink(trip)}`,
      { parse_mode: "Markdown" },
    );
  });

  bot.command("regeneratelink", async (ctx) => {
    const user = ctx.state.user as DbUser;
    const trip = await requireTrip(ctx, user);
    if (!trip) return;
    await updateTrip(trip.id, { share_slug: nanoid(16) });
    const updated = await getTrip(trip.id);
    await ctx.reply(`🔗 Old link is dead. New family link:\n${tripLink(updated!)}`);
  });

  bot.command("invite", async (ctx) => {
    const user = ctx.state.user as DbUser;
    const code = nanoid(10);
    await createInvite(code, user.telegram_id);
    await ctx.reply(`🎟️ One-time invite code (friend sends it to this bot):\n\`${code}\``, {
      parse_mode: "Markdown",
    });
  });

  bot.command("refreshplan", async (ctx) => {
    const user = ctx.state.user as DbUser;
    const trip = await requireTrip(ctx, user);
    if (!trip) return;
    const updated = await refreshPlan(trip.id);
    await ctx.reply(updated > 0 ? `🔄 Refreshed ${updated} plan segment(s) from Komoot.` : "No linked plan segments to refresh.");
  });

  bot.on("message:document", async (ctx) => {
    const user = ctx.state.user as DbUser;
    const trip = await requireTrip(ctx, user);
    if (!trip) return;
    const doc = ctx.message.document;
    const name = (doc.file_name ?? "").toLowerCase();
    const isGpx = name.endsWith(".gpx");
    const isFit = name.endsWith(".fit");
    if (!isGpx && !isFit) {
      await ctx.reply("I can only read .gpx and .fit files.");
      return;
    }
    if ((doc.file_size ?? 0) > 20 * 1024 * 1024) {
      await ctx.reply("File too large — Telegram bots can only download files up to 20 MB.");
      return;
    }
    await ctx.reply("⏳ Parsing track…").catch(() => {});
    try {
      const buffer = await downloadTelegramFile(bot, doc.file_id);
      const track = isGpx ? parseGpx(new TextDecoder().decode(buffer)) : await parseFit(buffer);
      const caption = ctx.message.caption?.toLowerCase() ?? "";
      if (caption.includes("plan")) {
        await savePlanSegment(ctx, trip, track);
      } else {
        await saveTrackSegment(ctx, trip, track, isGpx ? "gpx" : "fit");
      }
    } catch (err) {
      await ctx.reply(`⚠️ Could not parse that file: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  });

  bot.on("message:photo", async (ctx) => {
    const user = ctx.state.user as DbUser;
    const trip = await requireTrip(ctx, user);
    if (!trip) return;
    const day = await requireDay(ctx, trip);
    if (!day) return;

    const sizes = ctx.message.photo;
    const best = sizes[sizes.length - 1];
    try {
      const buffer = await downloadTelegramFile(bot, best.file_id);
      const path = `${trip.id}/day-${day.day_number}/${nanoid(8)}.jpg`;
      const { error: uploadError } = await supabase()
        .storage.from("photos")
        .upload(path, buffer, { contentType: "image/jpeg" });
      if (uploadError) throw uploadError;

      // Pin the photo to the route by timestamp (Telegram strips EXIF/GPS).
      const photoTimeMs = ctx.message.date * 1000;
      const { data: segments } = await supabase()
        .from("track_segments")
        .select("geojson")
        .eq("day_id", day.id);
      let matched: { lat: number; lng: number } | null = null;
      for (const seg of segments ?? []) {
        matched = matchPhotoToTrack(photoTimeMs, fromGeoJson(seg.geojson as TrackGeoJson));
        if (matched) break;
      }

      const { error } = await supabase().from("media").insert({
        day_id: day.id,
        storage_path: path,
        caption: ctx.message.caption ?? null,
        telegram_date: new Date(photoTimeMs).toISOString(),
        matched_lat: matched?.lat ?? null,
        matched_lng: matched?.lng ?? null,
      });
      if (error) throw error;
      await ctx.reply(`📸 Added to day ${day.day_number}${matched ? " and pinned on the map" : ""}.`);
    } catch (err) {
      await ctx.reply(`⚠️ Photo upload failed: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  });

  bot.on("message:text", async (ctx) => {
    const user = ctx.state.user as DbUser;
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return; // unknown command, stay quiet

    const trip = await requireTrip(ctx, user);
    if (!trip) return;

    const liveMatch = text.match(LIVETRACK_RE);
    if (liveMatch) {
      await updateTrip(trip.id, {
        live_url: liveMatch[0],
        live_expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      });
      await ctx.reply("🔴 Live banner is on for 24h — family sees it at the top of the trip page.");
      return;
    }

    const komootUrl = findKomootUrl(text);
    if (komootUrl) {
      await ingestKomootUrl(ctx, trip, komootUrl);
      return;
    }

    // Plain text → journal note for the current day.
    const day = await requireDay(ctx, trip);
    if (!day) return;
    const { error } = await supabase().from("notes").insert({ day_id: day.id, text });
    if (error) throw error;
    await ctx.reply(`📝 Noted for day ${day.day_number}.`);
  });

  return bot;
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
          geojson: toGeoJson(decimate(tour.points, 4000)),
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

declare module "grammy" {
  interface Context {
    state: { user: DbUser };
  }
}
