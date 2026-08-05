import { Bot, InputFile, type Context } from "grammy";
import { nanoid } from "nanoid";
import { env } from "./env.server";
import { supabase } from "./supabase.server";
import {
  chatHasTrips,
  createInvite,
  createTrip,
  createUser,
  deleteTrip,
  ensureChat,
  ensureDay,
  finishTrip,
  getActiveTrip,
  getTrip,
  getUser,
  lastUsedDayNumber,
  listTrips,
  pruneDaysBeyond,
  realignDayDates,
  redeemInvite,
  reopenTrip,
  setActiveTrip,
  tripDayCount,
  updateTrip,
  INVITE_TTL_DAYS,
  type DbChat,
  type DbTrip,
} from "./db.server";
import { fetchKomootTour, findKomootUrl, parseKomootUrl, mergeKomootTours, type MergeKomootResult } from "./komoot";
import { findLiveTrackUrl } from "./live-link";
import { probeLiveSession } from "./livetrack.server";
import { parseFit, parseGpx } from "./gpx";
import { decimate, fromGeoJson, toGeoJson, type NormalizedTrack, type TrackGeoJson, type TrackPoint, computeStats } from "./track";
import { toGpx } from "./gpx-export";
import { matchPhotoToTrack } from "./photo-match";
import { fetchDayWeather } from "./weather";
import { renderOgCard } from "./og.server";
import { buildArchive } from "./archive.server";
import { escapeErr, escapeMd, slugId } from "./telegram-md";
import { deleteEntity, ENTITY_LABEL, type EntityType } from "./entities.server";
import { parseAction } from "./manage";
import {
  applyDelete,
  clearDay,
  confirmView,
  dayTally,
  dayView,
  overview,
  tallyTotal,
  type View,
} from "./manage.server";

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

/**
 * Send a /manage screen as a new message, and swap one for the next in place.
 *
 * Editing keeps the whole browse-and-delete flow in a single message instead of
 * pushing a new one into the chat on every tap. Telegram rejects an edit whose
 * text and keyboard are both unchanged, which is a normal thing to happen when
 * a button is tapped twice — that one is not worth surfacing.
 */
async function sendView(ctx: Context, view: View) {
  await ctx.reply(view.text, {
    reply_markup: view.keyboard,
    ...(view.markdown ? { parse_mode: "Markdown" as const } : {}),
    link_preview_options: { is_disabled: !view.preview },
  });
}

async function editView(ctx: Context, view: View) {
  try {
    await ctx.editMessageText(view.text, {
      reply_markup: view.keyboard,
      ...(view.markdown ? { parse_mode: "Markdown" as const } : {}),
      link_preview_options: { is_disabled: !view.preview },
    });
  } catch {
    // The message is too old to edit, or nothing about it changed. Either way
    // the traveller still needs to see the screen they asked for.
    await sendView(ctx, view).catch(() => {});
  }
}

interface BotState {
  chat: DbChat;
  senderId: number;
  senderName: string;
  isGroup: boolean;
  isRegistered: boolean;
  isOwner: boolean;
}

const HELP = `🚴 *TrackTale* — your trip journal

*Trip setup*
/newtrip Name | 2026-08-01 — end date optional, add it with | 2026-08-10
/trips — list this chat's trips
/usetrip 2 — switch active trip (reopens a finished one)
/day 3 — set the day uploads go to
/day3, /nextday, /previousday — same, quicker
/trip — status + family link
/regeneratelink — new family link

*Changing a trip*
/renametrip New name
/dates 2026-08-01 | 2026-08-12
/reminders on — or off, per trip
/endtrip — mark it finished; pages stay, uploads stop
/deletetrip Name — erase it and its photos, forever

*During the trip* (everything lands on the current /day)
• Komoot share link → route imported
• GPX or FIT file → route imported (several merge into one day)
• Photos with captions → day gallery, pinned on the map
• Any other text → journal entry

*Oops*
/undo — remove the last thing added
Reply /delete to one of my messages — removes that one
/manage — browse the trip and delete anything on it, however old: notes,
photos, tracks, and guestbook messages the family left
/clearday 3 — empty a whole day: every note, photo and track on it

*Live*
🔴 Paste a Garmin LiveTrack link → live banner for 24h
/live — what the family page is showing right now
/live off — take the banner down

*Plan*
• A *planned* Komoot tour link → grey plan line + progress
• GPX with caption "plan" → same
/refreshplan — re-sync plan links after editing in Komoot
/refreshweather — fill in weather for older days

*Tools*
/merge "Tour Name" url1 url2 ... — fetch Komoot tours, merge by time, send GPX
/mergegpx "Tour Name" — merge your recent GPX uploads (last hour) into one GPX

*Looking back*
/mypage — your permanent page with every trip on it
/archive — download this trip as a self-contained file

/invite — invite code for a friend (valid 7 days)

_Add me to a group and everyone travelling can contribute — photos and notes are credited by name._
_Invited friends run their own trips in their own chats — you don't need to be there._`;

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
  let triedCode = false;
  if (!user && !isGroup) {
    const text = ctx.message?.text?.trim() ?? "";
    const codeMatch = text.match(/^(?:\/start\s+)?([A-Za-z0-9_-]{8,21})$/);
    if (codeMatch) {
      triedCode = true;
      if (await redeemInvite(codeMatch[1], from.id)) {
        user = await createUser(from.id, senderName, false);
        await ctx.reply("✅ Welcome to TrackTale! Send /help to see how it works.").catch(() => {});
      }
    }
  }

  // Check access before touching the database, so an unknown group that adds
  // the bot cannot make us create rows for it.
  const allowed = user !== null || (isGroup && (await chatHasTrips(chat.id)));
  if (!allowed) {
    if (ctx.message && !isGroup) {
      await ctx
        .reply(
          triedCode
            ? `🔒 That code doesn't work — invite codes last ${INVITE_TTL_DAYS} days and can only be used once. Ask for a fresh one.`
            : "🔒 This is a private bot. Ask the owner for an invite code and send it here.",
        )
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
    isOwner: user?.is_owner ?? false,
  };
}

/**
 * Ending or deleting a trip is not something any passer-by in a group should be
 * able to do — it stays with whoever created it (and the bot's owner).
 */
async function requireTripManager(ctx: Context, trip: DbTrip): Promise<boolean> {
  const { senderId, isOwner } = ctx.state;
  if (senderId === trip.owner_telegram_id || isOwner) return true;
  await ctx.reply("Only the traveller who created this trip can do that.");
  return false;
}

async function requireTrip(ctx: Context): Promise<DbTrip | null> {
  const { chat } = ctx.state;
  const trip = await getActiveTrip(chat);
  if (!trip) {
    await ctx.reply(
      "No active trip here. Create one:\n/newtrip Name | 2026-08-01",
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

/** tripDayCount is Infinity for a trip with no end date yet — /day is unbounded until /endtrip. */
function dayRange(max: number): string {
  return Number.isFinite(max) ? `1–${max}` : "1 or more";
}

/**
 * Shared body of /day <n>, /dayN, /nextday, /previousday: n is assumed to
 * already be a valid integer within [1, max] — callers handle their own
 * usage/boundary messaging before reaching here.
 */
async function setCurrentDay(ctx: Context, trip: DbTrip, n: number) {
  const day = await ensureDay(trip, n);
  await updateTrip(trip.id, { current_day_number: n });
  await ctx.reply(`📅 Day ${n} (${day.date}) is now current — uploads land here.`);
}

function tripLink(trip: DbTrip): string {
  return `${env.appOrigin}/t/${trip.share_slug}`;
}

function km(m: number): string {
  return (m / 1000).toFixed(1);
}

interface TripTotals {
  distanceM: number;
  elevationUp: number;
  daysWithTracks: number;
  planM: number;
}

async function tripTotals(tripId: string): Promise<TripTotals> {
  const { data: days } = await supabase()
    .from("days")
    .select("id, day_number, track_segments(distance_m, elevation_up)")
    .eq("trip_id", tripId);

  const totals: TripTotals = { distanceM: 0, elevationUp: 0, daysWithTracks: 0, planM: 0 };
  for (const d of days ?? []) {
    const segs = (d as { track_segments: { distance_m: number; elevation_up: number }[] })
      .track_segments;
    if (segs.length > 0) totals.daysWithTracks++;
    for (const s of segs) {
      totals.distanceM += s.distance_m;
      totals.elevationUp += s.elevation_up;
    }
  }

  const { data: plans } = await supabase()
    .from("plan_segments")
    .select("distance_m")
    .eq("trip_id", tripId);
  totals.planM = (plans ?? []).reduce((sum, p) => sum + p.distance_m, 0);
  return totals;
}

/**
 * Cache a day's weather, taken at the midpoint of the route it covers.
 * Returns whether anything was stored — callers on the upload path ignore it,
 * since weather is never worth failing an upload over.
 */
async function cacheDayWeather(
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

  await cacheDayWeather(day.id, day.date, points);

  const { count } = await supabase()
    .from("track_segments")
    .select("*", { count: "exact", head: true })
    .eq("day_id", day.id);

  const parts = [
    `✅ Saved to *day ${day.day_number}*${track.name ? ` — ${escapeMd(track.name)}` : ""}`,
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
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    // The end date is optional — /endtrip marks a trip done whenever that
    // turns out to be, so committing to a date up front is rarely useful.
    if (!name || !dateRe.test(start ?? "") || (end !== undefined && !dateRe.test(end))) {
      await ctx.reply("Format: /newtrip Name | 2026-08-01 (end date optional: | 2026-08-10)");
      return;
    }
    if (end !== undefined && Date.parse(end) < Date.parse(start)) {
      await ctx.reply("End date is before start date.");
      return;
    }
    const trip = await createTrip({
      chat_id: chat.chat_id,
      owner_telegram_id: senderId,
      name,
      start_date: start,
      end_date: end ?? null,
      share_slug: slugId(16),
    });
    const length = Number.isFinite(tripDayCount(trip)) ? ` (${tripDayCount(trip)} days)` : "";
    await ctx.reply(
      `🎒 Trip *${escapeMd(name)}*${length} created and set active.\n\n` +
        `👨‍👩‍👧 Family link:\n${tripLink(trip)}\n\n` +
        `Next: /day 1, then send tracks. Optional: send planned Komoot links for the grey plan line.`,
      { parse_mode: "Markdown" },
    );
  });

  bot.command("trips", async (ctx) => {
    const { chat } = ctx.state;
    const trips = await listTrips(chat.chat_id);
    if (trips.length === 0) {
      await ctx.reply("No trips in this chat yet. /newtrip Name | 2026-08-01");
      return;
    }
    const lines = trips.map((t, i) => {
      const mark = t.id === chat.active_trip_id ? " ✅ active" : t.finished_at ? " 🏁 finished" : "";
      return `${i + 1}. ${t.name} (${t.start_date} → ${t.end_date ?? "ongoing"})${mark}`;
    });
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
    // Picking a finished trip is how you reopen one you ended too early.
    if (trip.finished_at) {
      await reopenTrip(trip);
      await ctx.reply(`✅ Active trip: ${trip.name} — reopened, so uploads land here again.`);
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
      await ctx.reply(`Usage: /day <${dayRange(max)}>`);
      return;
    }
    await setCurrentDay(ctx, trip, n);
  });

  // "/day3" (no space) — Telegram parses this as a literal command named "day3",
  // so grammy's bot.command("day", ...) never sees it. Catch it here instead.
  bot.hears(/^\/day(\d+)(?:@\w+)?$/i, async (ctx) => {
    const trip = await requireTrip(ctx);
    if (!trip) return;
    const n = parseInt(ctx.match![1], 10);
    const max = tripDayCount(trip);
    if (!Number.isInteger(n) || n < 1 || n > max) {
      await ctx.reply(`Usage: /day <${dayRange(max)}>`);
      return;
    }
    await setCurrentDay(ctx, trip, n);
  });

  bot.hears(/^\/nextday(?:@\w+)?$/i, async (ctx) => {
    const trip = await requireTrip(ctx);
    if (!trip) return;
    const n = (trip.current_day_number ?? 0) + 1;
    const max = tripDayCount(trip);
    if (n > max) {
      await ctx.reply(`You're already on the last day (${max}).`);
      return;
    }
    await setCurrentDay(ctx, trip, n);
  });

  bot.hears(/^\/previousday(?:@\w+)?$/i, async (ctx) => {
    const trip = await requireTrip(ctx);
    if (!trip) return;
    const n = (trip.current_day_number ?? 2) - 1;
    const max = tripDayCount(trip);
    if (n < 1) {
      await ctx.reply("You're already on day 1.");
      return;
    }
    await setCurrentDay(ctx, trip, n);
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
    await deleteEntity(action.entity_type as EntityType, action.entity_id);
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
    await deleteEntity(action.entity_type as EntityType, action.entity_id);
    await ctx.reply(`↩️ ${ENTITY_LABEL[action.entity_type as EntityType]} removed.`);
  });

  /**
   * Empty a whole day at once — the tool for a day uploaded against the wrong
   * day number, or built from the wrong files. Two steps, because it takes off
   * more in one command than anything else the bot does short of /deletetrip.
   */
  bot.command("clearday", async (ctx) => {
    const trip = await requireTrip(ctx);
    if (!trip) return;

    const parts = (ctx.match as string).trim().split(/\s+/).filter(Boolean);
    const n = parseInt(parts[0] ?? "", 10);
    const max = tripDayCount(trip);
    if (!Number.isInteger(n) || n < 1 || n > max) {
      await ctx.reply(`Usage: /clearday <${dayRange(max)}> — empties that day.`);
      return;
    }

    const tally = await dayTally(trip, n);
    if (!tally || tallyTotal(tally) === 0) {
      await ctx.reply(`Day ${n} has nothing on it.`);
      return;
    }

    const what = [
      tally.tracks > 0 ? `${tally.tracks} track(s)` : null,
      tally.photos > 0 ? `${tally.photos} photo(s)` : null,
      tally.notes > 0 ? `${tally.notes} note(s)` : null,
    ]
      .filter(Boolean)
      .join(", ");

    if (parts[1]?.toLowerCase() !== "confirm") {
      await ctx.reply(
        `Day ${n} holds ${what}. Clearing takes all of it off for good, photos and all.\n\n` +
          (tally.comments > 0
            ? `The ${tally.comments} guestbook message(s) stay — /manage removes those one at a time.\n\n`
            : "") +
          `Confirm with:\n/clearday ${n} confirm`,
      );
      return;
    }

    await ctx.reply("🗑️ Clearing…").catch(() => {});
    try {
      await clearDay(trip, n);
      await ctx.reply(`🗑️ Day ${n} is empty — ${what} removed. Send /day ${n} to start it again.`);
      // The day's distance was part of what the share card showed.
      await renderOgCard(trip.id).catch(() => {});
    } catch (err) {
      await ctx.reply(
        `⚠️ Clearing day ${n} failed: ${err instanceof Error ? err.message : "unknown error"}.`,
      );
    }
  });

  // Browsing the trip to delete something older than the chat's scrollback.
  bot.command("manage", async (ctx) => {
    const trip = await requireTrip(ctx);
    if (!trip) return;
    await sendView(ctx, await overview(trip));
  });
  bot.hears(/^\/(edit|items)(?:@\w+)?$/i, async (ctx) => {
    const trip = await requireTrip(ctx);
    if (!trip) return;
    await sendView(ctx, await overview(trip));
  });

  bot.on("callback_query:data", async (ctx) => {
    const action = parseAction(ctx.callbackQuery.data);
    if (!action) {
      // A button from a deploy ago, or from a message older than the trip it
      // belonged to. Clearing the spinner is all we owe it.
      await ctx.answerCallbackQuery("That button is out of date — send /manage again.");
      return;
    }

    const trip = await getActiveTrip(ctx.state.chat);
    if (!trip) {
      await ctx.answerCallbackQuery("No active trip in this chat any more.");
      return;
    }

    try {
      let view: View | null = null;
      // Shown as the little toast above the keyboard, when there is anything
      // worth saying that the redrawn screen doesn't already say by itself.
      let notice: string | undefined;

      switch (action.type) {
        case "home":
          view = await overview(trip);
          break;
        case "day":
          view = await dayView(trip, action.dayNumber, action.page);
          break;
        case "ask":
          view = await confirmView(trip, action.kind, action.id, action.dayNumber);
          break;
        case "confirm":
          view = await applyDelete(trip, action.kind, action.id, action.dayNumber);
          // A deleted track changes the distance the share card shows.
          if (view && action.kind === "track_segment") {
            await renderOgCard(trip.id).catch(() => {});
          }
          break;
      }

      // Both item screens return null for something that has already gone —
      // a double tap, or two people tidying up at once. Fall back to the day.
      if (!view) {
        notice = "That one is already gone.";
        view = await dayView(trip, "dayNumber" in action ? action.dayNumber : 0, 0);
      }

      await ctx.answerCallbackQuery(notice);
      await editView(ctx, view);
    } catch (err) {
      console.error("manage callback failed", err);
      await ctx.answerCallbackQuery("Something went wrong — nothing was changed.");
    }
  });

  bot.command("mypage", async (ctx) => {
    const { senderId, senderName, isRegistered } = ctx.state;
    if (!isRegistered) {
      await ctx.reply("Only invited travellers have a page.");
      return;
    }
    const { data: user } = await supabase()
      .from("users")
      .select("traveler_slug")
      .eq("telegram_id", senderId)
      .maybeSingle();

    let slug = user?.traveler_slug as string | null | undefined;
    if (!slug) {
      slug = slugId(20);
      await supabase().from("users").update({ traveler_slug: slug }).eq("telegram_id", senderId);
    }
    await ctx.reply(
      `🧭 ${escapeMd(senderName)}'s permanent page — share it once and every future trip appears on it:\n` +
        `${env.appOrigin}/traveler/${slug}\n\n` +
        `_Anyone with this link sees all your trips. /newmypage makes a fresh link and kills this one._`,
      { parse_mode: "Markdown" },
    );
  });

  bot.command("newmypage", async (ctx) => {
    const { senderId, isRegistered } = ctx.state;
    if (!isRegistered) return;
    const slug = slugId(20);
    await supabase().from("users").update({ traveler_slug: slug }).eq("telegram_id", senderId);
    await ctx.reply(`🔗 Old page link is dead. New one:\n${env.appOrigin}/traveler/${slug}`);
  });

  bot.command("archive", async (ctx) => {
    const trip = await requireTrip(ctx);
    if (!trip) return;
    await ctx.reply("📦 Building the archive — this can take a moment…").catch(() => {});
    try {
      const result = await buildArchive(trip.id, env.appOrigin);
      const mb = result.zip.byteLength / 1024 / 1024;
      // Telegram refuses bot uploads over 50 MB, so large bundles go by link.
      if (mb < 45) {
        await ctx.replyWithDocument(new InputFile(Buffer.from(result.zip), result.filename), {
          caption:
            `📦 *${escapeMd(trip.name)}* — self-contained archive (${mb.toFixed(1)} MB).\n` +
            `Open index.html; map, charts and photos all work offline.`,
          parse_mode: "Markdown",
        });
      } else {
        await ctx.reply(
          `📦 Archive ready (${mb.toFixed(0)} MB — too big for Telegram, so here's a link):\n${result.publicUrl}`,
        );
      }
    } catch (err) {
      await ctx.reply(
        `⚠️ Archive failed: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    }
  });

  bot.command("trip", async (ctx) => {
    const trip = await requireTrip(ctx);
    if (!trip) return;
    const totals = await tripTotals(trip.id);
    const progress =
      totals.planM > 0
        ? ` (${Math.min(100, Math.round((totals.distanceM / totals.planM) * 100))}% of plan)`
        : "";

    await ctx.reply(
      `🎒 *${escapeMd(trip.name)}* — ${trip.start_date} → ${trip.end_date ?? "ongoing"}\n` +
        `📅 Current day: ${trip.current_day_number ?? "not set"}\n` +
        `📏 ${km(totals.distanceM)} km over ${totals.daysWithTracks} tracked days${progress}\n` +
        `🔔 Reminders ${trip.reminders_enabled ? "on" : "off"}\n` +
        `👨‍👩‍👧 ${tripLink(trip)}`,
      { parse_mode: "Markdown" },
    );
  });

  bot.command("endtrip", async (ctx) => {
    const trip = await requireTrip(ctx);
    if (!trip) return;
    if (!(await requireTripManager(ctx, trip))) return;

    await finishTrip(trip);
    const totals = await tripTotals(trip.id);
    await ctx.reply(
      `🏁 *${escapeMd(trip.name)}* is finished — ${km(totals.distanceM)} km and ` +
        `${Math.round(totals.elevationUp)} m of climbing over ${totals.daysWithTracks} days.\n\n` +
        `Nothing more lands here until you start or pick another trip. The family link keeps working:\n` +
        `${tripLink(trip)}\n\n` +
        `_/archive saves it as a file. /usetrip picks it up again if you ended it early._`,
      { parse_mode: "Markdown" },
    );
  });

  bot.command("deletetrip", async (ctx) => {
    const { chat } = ctx.state;
    const typed = (ctx.match as string).trim();
    const trips = await listTrips(chat.chat_id);
    if (trips.length === 0) {
      await ctx.reply("No trips in this chat.");
      return;
    }
    if (!typed) {
      await ctx.reply(
        "Deleting a trip removes its days, photos, notes and family page for good — " +
          "there is no undo.\n\nType the name to confirm, e.g.\n" +
          `/deletetrip ${trips[0].name}`,
      );
      return;
    }

    const matches = trips.filter((t) => t.name.toLowerCase() === typed.toLowerCase());
    if (matches.length === 0) {
      await ctx.reply(
        `No trip here is called "${typed}". /trips lists them — the name has to match exactly.`,
      );
      return;
    }
    if (matches.length > 1) {
      await ctx.reply(
        `Two trips share that name, so I won't guess. Rename one with /renametrip first.`,
      );
      return;
    }

    const trip = matches[0];
    if (!(await requireTripManager(ctx, trip))) return;
    await ctx.reply("🗑️ Deleting — this takes a moment…").catch(() => {});
    try {
      await deleteTrip(trip);
      await ctx.reply(`🗑️ *${escapeMd(trip.name)}* is gone, photos and all.`, {
        parse_mode: "Markdown",
      });
    } catch (err) {
      await ctx.reply(
        `⚠️ Delete failed: ${err instanceof Error ? err.message : "unknown error"}. Nothing was removed.`,
      );
    }
  });

  /**
   * The live banner is the one feature nobody can check for themselves: it
   * lives on the family's page, driven by a page on Garmin's servers that we
   * only scrape. This says what the server sees right now.
   */
  bot.command("live", async (ctx) => {
    const trip = await requireTrip(ctx);
    if (!trip) return;
    const arg = (ctx.match as string).trim().toLowerCase();

    if (arg === "off") {
      await updateTrip(trip.id, { live_url: null, live_expires_at: null });
      await ctx.reply("⚫️ Live banner off. Paste a LiveTrack link to switch it back on.");
      return;
    }

    const expiresMs = trip.live_expires_at ? Date.parse(trip.live_expires_at) : NaN;
    if (!trip.live_url || !Number.isFinite(expiresMs) || expiresMs <= Date.now()) {
      await ctx.reply(
        "⚫️ No live link on this trip" +
          (trip.live_url ? " (the last one has expired)" : "") +
          ".\n\nPaste a Garmin LiveTrack link here, or let Garmin email it to the inbound address.",
      );
      return;
    }

    await ctx.reply("🔍 Asking Garmin…").catch(() => {});
    const probe = await probeLiveSession(trip.live_url);
    const hoursLeft = Math.max(0, Math.round((expiresMs - Date.now()) / 3600000));
    const lines = [
      `🔴 Live link is set, ${hoursLeft}h left on it.`,
      trip.live_url,
      "",
      `Garmin: ${probe.detail}.`,
    ];
    if (probe.session) {
      lines.push(
        `Session: ${probe.session.name ?? "unnamed"} — ` +
          `${km(probe.session.distanceM)} km, ` +
          (probe.session.complete ? "finished" : "running") +
          (probe.session.updatedAt ? `, last point ${probe.session.updatedAt}` : ""),
      );
      if (probe.session.complete) {
        lines.push("", "The banner is hidden while Garmin reports the session as over.");
      } else if (probe.session.points.length === 0) {
        lines.push("", "The banner is up, but there is no position to draw yet.");
      }
    } else {
      lines.push("", "The banner is up but shows no route — it just links to Garmin.");
    }
    lines.push("", "/live off takes the banner down.");
    // Plain text: the session name is Garmin's, not something we can escape for.
    await ctx.reply(lines.join("\n"), { link_preview_options: { is_disabled: true } });
  });

  bot.command("reminders", async (ctx) => {
    const trip = await requireTrip(ctx);
    if (!trip) return;
    const arg = (ctx.match as string).trim().toLowerCase();
    if (arg !== "on" && arg !== "off") {
      await ctx.reply(
        `Reminders for *${escapeMd(trip.name)}* are *${trip.reminders_enabled ? "on" : "off"}*.\n` +
          `Change with /reminders on or /reminders off.`,
        { parse_mode: "Markdown" },
      );
      return;
    }
    await updateTrip(trip.id, { reminders_enabled: arg === "on" });
    await ctx.reply(
      arg === "on"
        ? "🔔 Reminders on — I'll ping this chat quietly when a day has no track."
        : "🔕 Reminders off for this trip. Everything else works as before.",
    );
  });

  bot.command("renametrip", async (ctx) => {
    const trip = await requireTrip(ctx);
    if (!trip) return;
    if (!(await requireTripManager(ctx, trip))) return;
    const name = (ctx.match as string).trim();
    if (!name) {
      await ctx.reply("Usage: /renametrip A better name");
      return;
    }
    await updateTrip(trip.id, { name });
    await ctx.reply(`✏️ Renamed to *${escapeMd(name)}*.`, { parse_mode: "Markdown" });
  });

  bot.command("dates", async (ctx) => {
    const trip = await requireTrip(ctx);
    if (!trip) return;
    if (!(await requireTripManager(ctx, trip))) return;

    const [start, end] = (ctx.match as string).split("|").map((s) => s.trim());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(end ?? "")) {
      await ctx.reply("Format: /dates 2026-08-01 | 2026-08-12");
      return;
    }
    if (Date.parse(end) < Date.parse(start)) {
      await ctx.reply("End date is before start date.");
      return;
    }

    // Shrinking the trip past a day that already holds something would strand
    // that day off the end of the calendar, so refuse rather than lose it.
    const newLength = Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1;
    const lastUsed = await lastUsedDayNumber(trip.id);
    if (lastUsed > newLength) {
      await ctx.reply(
        `That range is ${newLength} days, but day ${lastUsed} already has things on it. ` +
          `Delete those first, or pick a later end date.`,
      );
      return;
    }

    await updateTrip(trip.id, {
      start_date: start,
      end_date: end,
      // A current day past the new end would send the next upload nowhere.
      current_day_number:
        trip.current_day_number && trip.current_day_number > newLength
          ? newLength
          : trip.current_day_number,
    });
    const updated = await getTrip(trip.id);
    if (updated) {
      await pruneDaysBeyond(trip.id, newLength);
      await realignDayDates(updated);
    }
    await ctx.reply(
      `📆 Dates updated: ${start} → ${end} (${newLength} days).` +
        (updated?.current_day_number !== trip.current_day_number
          ? `\nCurrent day moved to ${updated?.current_day_number}.`
          : ""),
    );
  });

  bot.command("regeneratelink", async (ctx) => {
    const trip = await requireTrip(ctx);
    if (!trip) return;
    await updateTrip(trip.id, { share_slug: slugId(16) });
    const updated = await getTrip(trip.id);
    await ctx.reply(`🔗 Old link is dead. New family link:\n${tripLink(updated!)}`);
  });

  bot.command("invite", async (ctx) => {
    const { senderId, isRegistered } = ctx.state;
    if (!isRegistered) {
      await ctx.reply("Only invited travellers can create invite codes.");
      return;
    }
    const code = slugId(10);
    const expiresAt = await createInvite(code, senderId);
    await ctx.reply(
      `🎟️ One-time invite code (friend sends it to me in a private chat):\n\`${code}\`\n\n` +
        `_Valid for ${INVITE_TTL_DAYS} days, until ${expiresAt.toISOString().slice(0, 10)}._`,
      { parse_mode: "Markdown" },
    );
  });

  bot.command("merge", async (ctx) => {
    const raw = (ctx.match as string).trim();
    if (!raw) {
      await ctx.reply(
        "Usage: /merge <name> <url1> <url2> ...\n" +
          'Example: /merge "Day 3" https://komoot.com/tour/123 https://komoot.com/tour/456\n' +
          "Or without quotes: /merge Day 3 https://komoot.com/tour/123 https://komoot.com/tour/456",
      );
      return;
    }

    // Split by whitespace, then find first URL - everything before is the name
    const tokens = raw.split(/\s+/);
    const firstUrlIdx = tokens.findIndex((t) => parseKomootUrl(t));
    if (firstUrlIdx <= 0) {
      await ctx.reply("Need a name and at least two Komoot URLs.");
      return;
    }
    const name = tokens.slice(0, firstUrlIdx).join(" ");
    const urls = tokens.slice(firstUrlIdx);

    const komootUrls = urls.filter((u) => parseKomootUrl(u));
    if (komootUrls.length < 2) {
      await ctx.reply("At least two valid Komoot tour URLs required.");
      return;
    }

    const invalid = urls.filter((u) => !parseKomootUrl(u));
    if (invalid.length > 0) {
      await ctx.reply(
        `⚠️ Skipping invalid URLs:\n${invalid.map((u) => `• ${u}`).join("\n")}`,
      );
    }

    await ctx.reply("⏳ Fetching tours and merging…").catch(() => {});

    try {
      const { gpx, skipped, fetched } = await mergeKomootTours(komootUrls, name);
      if (skipped.length > 0) {
        await ctx.reply(
          `⚠️ Skipped ${skipped.length} tour(s):\n${skipped.map((s) => `• ${s}`).join("\n")}`,
        );
      }
      await ctx.replyWithDocument(
        new InputFile(Buffer.from(gpx), `${name.replace(/[^a-z0-9_-]/gi, "_")}.gpx`),
        { caption: `✅ Merged ${fetched} tour(s) into ${name} (${(gpx.length / 1024).toFixed(1)} KB)` },
      );
    } catch (err) {
      await ctx.reply(`❌ Merge failed: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  });

  bot.command("mergegpx", async (ctx) => {
    const raw = (ctx.match as string).trim();
    const chatId = ctx.chat!.id;

    if (!raw) {
      // No args: show usage or finalize if session exists
      const { data: session } = await supabase()
        .from("gpx_merge_sessions")
        .select("name, tracks")
        .eq("chat_id", chatId)
        .maybeSingle();

      if (!session) {
        await ctx.reply(
          "Usage:\n" +
            '  /mergegpx "Tour Name" — start a new GPX merge session\n' +
            "  (upload .gpx files)\n" +
            "  /mergegpx — finish and send merged GPX",
        );
        return;
      }

      // Finalize: merge tracks from session
      const tracks = session.tracks ?? [];

      if (!tracks || tracks.length < 2) {
        await ctx.reply("Need at least 2 GPX files in session. Upload more first.");
        return;
      }

      const allPoints: TrackPoint[] = [];
      const sports = new Map<string, number>();
      for (const t of tracks) {
        const pts = t.points ?? [];
        allPoints.push(...pts);
        if (t.sport) sports.set(t.sport, (sports.get(t.sport) ?? 0) + 1);
      }

      const hasTime = allPoints.every((p) => p.time !== undefined);
      if (hasTime) allPoints.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));

      let sport: string | undefined;
      let maxCount = 0;
      for (const [s, c] of sports) {
        if (c > maxCount) {
          maxCount = c;
          sport = s;
        }
      }

      computeStats(allPoints);
      const gpx = toGpx(session.name, [allPoints]);

      // Clean up session
      await supabase().from("gpx_merge_sessions").delete().eq("chat_id", chatId);

      await ctx.replyWithDocument(
        new InputFile(Buffer.from(gpx), `${session.name.replace(/[^a-z0-9_-]/gi, "_")}.gpx`),
        { caption: `✅ Merged ${tracks.length} GPX file(s) into ${session.name} (${(gpx.length / 1024).toFixed(1)} KB)` },
      );
      return;
    }

    // With args: start new session
    const name = raw;
    await supabase().from("gpx_merge_sessions").upsert({
      chat_id: chatId,
      name,
      tracks: [],
    });
    await ctx.reply(
      `📥 Started GPX merge session for "${name}".\nUpload .gpx files now.\nWhen done, send /mergegpx to finish.`,
    );
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

  // Weather is normally cached the moment a track lands. A day imported long
  // after the fact missed that, and a day uploaded once the forecast window had
  // already moved past it got nothing at all — this fills both in from the
  // historical archive.
  bot.command("refreshweather", async (ctx) => {
    const trip = await requireTrip(ctx);
    if (!trip) return;
    const { data: days } = await supabase()
      .from("days")
      .select("id, day_number, date, track_segments(geojson)")
      .eq("trip_id", trip.id)
      .order("day_number");

    await ctx.reply("🌤️ Fetching weather — this can take a moment…").catch(() => {});
    let filled = 0;
    let skipped = 0;
    for (const day of days ?? []) {
      const segments = (day as { track_segments: { geojson: TrackGeoJson }[] }).track_segments;
      if (segments.length === 0) continue;
      const points = fromGeoJson(segments[0].geojson);
      if (await cacheDayWeather(day.id, day.date, points)) filled++;
      else skipped++;
    }
    await ctx.reply(
      filled > 0
        ? `🌤️ Weather updated for ${filled} day(s)${skipped > 0 ? `, ${skipped} unavailable` : ""}.`
        : "No weather found for this trip's days.",
    );
  });

  bot.on("message:document", async (ctx) => {
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

      // Check for active GPX merge session first
      if (isGpx) {
        const { data: session } = await supabase()
          .from("gpx_merge_sessions")
          .select("tracks")
          .eq("chat_id", ctx.chat!.id)
          .maybeSingle();

        if (session) {
          const trackData = {
            points: track.points,
            stats: track.stats,
            sport: track.sport,
            name: track.name,
          };
          const newTracks = [...(session.tracks ?? []), trackData];
          await supabase()
            .from("gpx_merge_sessions")
            .update({ tracks: newTracks })
            .eq("chat_id", ctx.chat!.id);
          await ctx.reply(`✅ Added "${doc.file_name}" (${newTracks.length} file(s) in session)`);
          return;
        }
      }

      const trip = await requireTrip(ctx);
      if (!trip) return;

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

    const liveUrl = findLiveTrackUrl(text);
    const komootUrl = findKomootUrl(text);

    // Links are unambiguous intent, so they work anywhere.
    if (liveUrl) {
      const trip = await requireTrip(ctx);
      if (!trip) return;
      await updateTrip(trip.id, {
        live_url: liveUrl,
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
