import { Bot, type Context } from "grammy";
import { nanoid } from "nanoid";
import { env } from "./env.server";
import { supabase } from "./supabase.server";
import {
  chatHasTrips,
  createInvite,
  createTrip,
  createUser,
  ensureChat,
  ensureDay,
  getActiveTrip,
  getTrip,
  getUser,
  listTrips,
  redeemInvite,
  setActiveTrip,
  tripDayCount,
  updateTrip,
  type DbChat,
  type DbTrip,
} from "./db.server";
import { fetchKomootTour, findKomootUrl, parseKomootUrl } from "./komoot";
import { parseFit, parseGpx } from "./gpx";
import { decimate, fromGeoJson, toGeoJson, type NormalizedTrack, type TrackGeoJson } from "./track";
import { matchPhotoToTrack } from "./photo-match";
import { fetchDayWeather } from "./weather";
import { renderOgCard } from "./og.server";

type EntityType = "note" | "media" | "track_segment" | "plan_segment" | "comment";

/**
 * Remember which row a confirmation message created, so replying /delete to it
 * removes exactly that thing — and /undo can walk back the most recent one.
 */
async function recordAction(
  ctx: Context,
  sent: { message_id: number } | undefined,
  entityType: EntityType,
  entityId: string,
) {
  if (!sent || !ctx.chat) return;
  await supabase().from("bot_actions").insert({
    chat_id: ctx.chat.id,
    message_id: sent.message_id,
    entity_type: entityType,
    entity_id: entityId,
  });
}

const ENTITY_TABLE: Record<EntityType, string> = {
  note: "notes",
  media: "media",
  track_segment: "track_segments",
  plan_segment: "plan_segments",
  comment: "comments",
};

const ENTITY_LABEL: Record<EntityType, string> = {
  note: "Note",
  media: "Photo",
  track_segment: "Track",
  plan_segment: "Plan segment",
  comment: "Comment",
};

async function deleteAction(action: { entity_type: EntityType; entity_id: string }): Promise<void> {
  if (action.entity_type === "media") {
    const { data } = await supabase()
      .from("media")
      .select("storage_path, thumb_path")
      .eq("id", action.entity_id)
      .maybeSingle();
    const paths = [data?.storage_path, data?.thumb_path].filter(Boolean) as string[];
    if (paths.length > 0) await supabase().storage.from("photos").remove(paths);
  }
  await supabase().from(ENTITY_TABLE[action.entity_type]).delete().eq("id", action.entity_id);
}

const LIVETRACK_RE = /https?:\/\/(?:livetrack\.garmin\.com|[a-z]+\.garmin\.com\/livetrack)[^\s]*/i;

interface BotState {
  chat: DbChat;
  senderId: number;
  senderName: string;
  isGroup: boolean;
  isRegistered: boolean;
}

const HELP = `🚴 *TrackTale* — your trip journal

*Trip setup*
/newtrip Name | 2026-08-01 | 2026-08-10
/trips — list this chat's trips
/usetrip 2 — switch active trip
/day 3 — set the day uploads go to
/trip — status + family link
/regeneratelink — new family link

*During the trip* (everything lands on the current /day)
• Komoot share link → route imported
• GPX or FIT file → route imported (several merge into one day)
• Photos with captions → day gallery, pinned on the map
• Any other text → journal entry
• Garmin LiveTrack link → 🔴 live banner for 24h

*Oops*
/undo — remove the last thing added
Reply /delete to one of my messages — removes that one

*Plan*
• A *planned* Komoot tour link → grey plan line + progress
• GPX with caption "plan" → same
/refreshplan — re-sync plan links after editing in Komoot

/invite — invite code for a friend

_Add me to a group and everyone travelling can contribute — photos and notes are credited by name._`;

/**
 * Decide whether we may act on this update, and gather sender identity.
 *
 * Private chats require a registered user. Groups are trusted once they contain
 * a trip — the person who created it was registered, and a private group's
 * members are there by invitation.
 */
async function authorize(ctx: Context): Promise<BotState | null> {
  const from = ctx.from;
  const chat = ctx.chat;
  if (!from || !chat) return null;

  const isGroup = chat.type === "group" || chat.type === "supergroup";
  const senderName = from.first_name ?? "Someone";

  let user = await getUser(from.id);
  if (!user && from.id === env.ownerTelegramId) {
    user = await createUser(from.id, senderName, true);
  }

  // An unregistered sender in a private chat can still redeem an invite code.
  if (!user && !isGroup) {
    const text = ctx.message?.text?.trim() ?? "";
    const codeMatch = text.match(/^(?:\/start\s+)?([A-Za-z0-9_-]{8,21})$/);
    if (codeMatch && (await redeemInvite(codeMatch[1], from.id))) {
      user = await createUser(from.id, senderName, false);
      await ctx.reply("✅ Welcome to TrackTale! Send /help to see how it works.").catch(() => {});
    }
  }

  // Check access before touching the database, so an unknown group that adds
  // the bot cannot make us create rows for it.
  const allowed = user !== null || (isGroup && (await chatHasTrips(chat.id)));
  if (!allowed) {
    if (ctx.message && !isGroup) {
      await ctx
        .reply("🔒 This is a private bot. Ask the owner for an invite code and send it here.")
        .catch(() => {});
    }
    return null;
  }

  const dbChat = await ensureChat(
    chat.id,
    chat.type,
    isGroup && "title" in chat ? chat.title : undefined,
  );

  return {
    chat: dbChat,
    senderId: from.id,
    senderName,
    isGroup,
    isRegistered: user !== null,
  };
}

async function requireTrip(ctx: Context): Promise<DbTrip | null> {
  const { chat } = ctx.state;
  const trip = await getActiveTrip(chat);
  if (!trip) {
    await ctx.reply(
      "No active trip here. Create one:\n/newtrip Name | 2026-08-01 | 2026-08-10",
    );
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
  const sent = await ctx.reply(parts.join("\n"), { parse_mode: "Markdown" }).catch(() => undefined);
  await recordAction(ctx, sent, "track_segment", inserted.id);

  // The share card shows progress, so it follows every new track.
  try {
    await renderOgCard(trip.id);
  } catch {
    // a stale card must never block an upload
  }
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
  await ctx
    .reply(
      `🗺️ Plan segment saved${track.name ? ` — ${track.name}` : ""} (${km(track.stats.distanceM)} km).` +
        (sourceUrl ? " It re-syncs daily; /refreshplan to sync now." : ""),
    )
    .catch(() => {});
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

async function saveNote(ctx: Context, text: string) {
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
    .reply(`📝 Noted for day ${day.day_number}. Reply /delete to remove.`)
    .catch(() => undefined);
  await recordAction(ctx, sent, "note", inserted.id);
}

export function createBot(): Bot {
  const bot = new Bot(env.telegramBotToken);

  bot.use(async (ctx, next) => {
    const state = await authorize(ctx);
    if (!state) return;
    ctx.state = state;
    await next();
  });

  bot.command("start", (ctx) => ctx.reply(HELP, { parse_mode: "Markdown" }));
  bot.command("help", (ctx) => ctx.reply(HELP, { parse_mode: "Markdown" }));

  bot.command("newtrip", async (ctx) => {
    const { chat, senderId, isRegistered } = ctx.state;
    if (!isRegistered) {
      await ctx.reply("Only invited travellers can create trips. Ask the owner for an invite code.");
      return;
    }
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
      chat_id: chat.chat_id,
      owner_telegram_id: senderId,
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
    const { chat } = ctx.state;
    const trips = await listTrips(chat.chat_id);
    if (trips.length === 0) {
      await ctx.reply("No trips in this chat yet. /newtrip Name | 2026-08-01 | 2026-08-10");
      return;
    }
    const lines = trips.map(
      (t, i) =>
        `${i + 1}. ${t.name} (${t.start_date} → ${t.end_date})${t.id === chat.active_trip_id ? " ✅ active" : ""}`,
    );
    await ctx.reply(lines.join("\n") + "\n\nSwitch with /usetrip <number>");
  });

  bot.command("usetrip", async (ctx) => {
    const { chat } = ctx.state;
    const trips = await listTrips(chat.chat_id);
    const idx = parseInt((ctx.match as string).trim(), 10) - 1;
    const trip = trips[idx];
    if (!trip) {
      await ctx.reply("Usage: /usetrip <number from /trips>");
      return;
    }
    await setActiveTrip(chat.chat_id, trip.id);
    await ctx.reply(`✅ Active trip: ${trip.name}`);
  });

  bot.command("day", async (ctx) => {
    const trip = await requireTrip(ctx);
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

  bot.command("note", async (ctx) => {
    const text = (ctx.match as string).trim();
    if (!text) {
      await ctx.reply("Usage: /note What happened today");
      return;
    }
    await saveNote(ctx, text);
  });

  bot.command("delete", async (ctx) => {
    const replyTo = ctx.message?.reply_to_message?.message_id;
    if (!replyTo) {
      await ctx.reply("Reply /delete to one of my confirmations, or use /undo for the last thing added.");
      return;
    }
    const { data: action } = await supabase()
      .from("bot_actions")
      .select("entity_type, entity_id")
      .eq("chat_id", ctx.chat!.id)
      .eq("message_id", replyTo)
      .maybeSingle();
    if (!action) {
      await ctx.reply("I don't have anything on record for that message.");
      return;
    }
    await deleteAction(action);
    await supabase()
      .from("bot_actions")
      .delete()
      .eq("chat_id", ctx.chat!.id)
      .eq("message_id", replyTo);
    await ctx.reply(`🗑️ ${ENTITY_LABEL[action.entity_type as EntityType]} deleted.`);
  });

  bot.command("undo", async (ctx) => {
    const { data: action } = await supabase()
      .from("bot_actions")
      .select("message_id, entity_type, entity_id")
      .eq("chat_id", ctx.chat!.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!action) {
      await ctx.reply("Nothing to undo here.");
      return;
    }
    await deleteAction(action);
    await supabase()
      .from("bot_actions")
      .delete()
      .eq("chat_id", ctx.chat!.id)
      .eq("message_id", action.message_id);
    await ctx.reply(`↩️ ${ENTITY_LABEL[action.entity_type as EntityType]} removed.`);
  });

  bot.command("trip", async (ctx) => {
    const trip = await requireTrip(ctx);
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
    const trip = await requireTrip(ctx);
    if (!trip) return;
    await updateTrip(trip.id, { share_slug: nanoid(16) });
    const updated = await getTrip(trip.id);
    await ctx.reply(`🔗 Old link is dead. New family link:\n${tripLink(updated!)}`);
  });

  bot.command("invite", async (ctx) => {
    const { senderId, isRegistered } = ctx.state;
    if (!isRegistered) {
      await ctx.reply("Only invited travellers can create invite codes.");
      return;
    }
    const code = nanoid(10);
    await createInvite(code, senderId);
    await ctx.reply(`🎟️ One-time invite code (friend sends it to me in a private chat):\n\`${code}\``, {
      parse_mode: "Markdown",
    });
  });

  bot.command("refreshplan", async (ctx) => {
    const trip = await requireTrip(ctx);
    if (!trip) return;
    const updated = await refreshPlan(trip.id);
    await ctx.reply(
      updated > 0
        ? `🔄 Refreshed ${updated} plan segment(s) from Komoot.`
        : "No linked plan segments to refresh.",
    );
  });

  bot.on("message:document", async (ctx) => {
    const trip = await requireTrip(ctx);
    if (!trip) return;
    const doc = ctx.message.document;
    const name = (doc.file_name ?? "").toLowerCase();
    const isGpx = name.endsWith(".gpx");
    const isFit = name.endsWith(".fit");
    if (!isGpx && !isFit) {
      if (!ctx.state.isGroup) await ctx.reply("I can only read .gpx and .fit files.");
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
    const trip = await requireTrip(ctx);
    if (!trip) return;
    const day = await requireDay(ctx, trip);
    if (!day) return;

    // Telegram already ships several resolutions — use a small one for the grid
    // so the family page stays cheap to load, and the largest for the lightbox.
    const sizes = [...ctx.message.photo].sort((a, b) => a.width - b.width);
    const full = sizes[sizes.length - 1];
    const thumb = sizes.find((s) => s.width >= 320) ?? full;

    try {
      const id = nanoid(8);
      const base = `${trip.id}/day-${day.day_number}/${id}`;
      const store = supabase().storage.from("photos");

      const fullBuf = await downloadTelegramFile(bot, full.file_id);
      const fullPath = `${base}.jpg`;
      const up = await store.upload(fullPath, fullBuf, { contentType: "image/jpeg" });
      if (up.error) throw up.error;

      let thumbPath: string | null = null;
      if (thumb.file_id !== full.file_id) {
        const thumbBuf = await downloadTelegramFile(bot, thumb.file_id);
        thumbPath = `${base}-thumb.jpg`;
        const upThumb = await store.upload(thumbPath, thumbBuf, { contentType: "image/jpeg" });
        if (upThumb.error) thumbPath = null;
      }

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

      const { senderId, senderName } = ctx.state;
      const { data: inserted, error } = await supabase().from("media").insert({
        day_id: day.id,
        storage_path: fullPath,
        thumb_path: thumbPath,
        caption: ctx.message.caption ?? null,
        telegram_date: new Date(photoTimeMs).toISOString(),
        matched_lat: matched?.lat ?? null,
        matched_lng: matched?.lng ?? null,
        author_telegram_id: senderId,
        author_name: senderName,
      })
        .select("id")
        .single();
      if (error) throw error;
      const sent = await ctx
        .reply(`📸 Added to day ${day.day_number}${matched ? " and pinned on the map" : ""}.`)
        .catch(() => undefined);
      await recordAction(ctx, sent, "media", inserted.id);
    } catch (err) {
      await ctx.reply(`⚠️ Photo upload failed: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return; // unknown command, stay quiet

    const liveMatch = text.match(LIVETRACK_RE);
    const komootUrl = findKomootUrl(text);

    // Links are unambiguous intent, so they work anywhere.
    if (liveMatch) {
      const trip = await requireTrip(ctx);
      if (!trip) return;
      await updateTrip(trip.id, {
        live_url: liveMatch[0],
        live_expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      });
      await ctx.reply("🔴 Live banner is on for 24h — family sees it at the top of the trip page.");
      return;
    }
    if (komootUrl) {
      const trip = await requireTrip(ctx);
      if (!trip) return;
      await ingestKomootUrl(ctx, trip, komootUrl);
      return;
    }

    // Trip chats exist for the journal, so plain text is a note everywhere.
    // Coordination chatter that slips in is one /delete reply away.
    await saveNote(ctx, text);
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
    state: BotState;
  }
}
