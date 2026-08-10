import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
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
import {
  decimate,
  fromGeoJson,
  planPointBudget,
  toGeoJson,
  type NormalizedTrack,
  type TrackGeoJson,
  type TrackPoint,
  computeStats,
} from "./track";
import { toGpx } from "./gpx-export";
import { matchPhotoToDay } from "./photo-match";
import { readExif, type ExifData } from "./exif";
import { imageDocument, type ImageDocument } from "./photo-file";
import { compressForWeb, formatBytes, COMPRESS_ABOVE_BYTES } from "./image.server";
import { findTwin, perceptualHash, type HashedPhoto } from "./phash";

import { fetchDayWeather } from "./weather";
import { renderOgCard } from "./og.server";
import { buildArchive } from "./archive.server";
import { escapeErr, escapeMd, slugId } from "./telegram-md";
import { deleteEntity, ENTITY_LABEL, type EntityType } from "./entities.server";
import { encodeAction, parseAction, type ItemKind } from "./manage";
import {
  applyDelete,
  clearDay,
  confirmView,
  dayTally,
  dayView,
  overview,
  replaceDayView,
  replaceOverview,
  replacePromptView,
  tallyTotal,
  type View,
} from "./manage.server";
import {
  armReplacement,
  clearReplacement,
  pendingReplacement,
  replacePhoto,
  type ReplacementFiles,
} from "./media-replace.server";
import {
  backToStatus,
  clearDayConfirmView,
  dayNavKeyboard,
  dayPickerView,
  describeTally,
  deleteTripConfirmView,
  endTripConfirmView,
  km,
  myPageConfirmView,
  pageOfDay,
  relinkConfirmView,
  tripFinishedView,
  tripLink,
  tripPickerView,
  tripStatusView,
} from "./screens.server";

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
 * What every confirmation carries: the way to take that one thing back off.
 *
 * The reply-`/delete` route still works, but it asks the traveller to remember
 * a command and to reply to the right message. The button is the same journey
 * through the /manage screens — tapping it opens the confirmation for exactly
 * this item, in place of the confirmation it was attached to.
 */
function undoKeyboard(kind: ItemKind, id: string, dayNumber: number): InlineKeyboard {
  const keyboard = new InlineKeyboard().text(
    "🗑 Delete this",
    encodeAction({ type: "ask", kind, id, dayNumber }),
  );
  // A photo is the one thing whose picture can be changed without losing what
  // the row means, and the moment right after sending it is when a better
  // version is most likely to be to hand.
  if (kind === "media") {
    keyboard.text("🔄 Swap picture", encodeAction({ type: "replacePick", id, dayNumber }));
  }
  return keyboard.text(`📅 Day ${dayNumber}`, encodeAction({ type: "day", dayNumber, page: 0 }));
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

/**
 * Swap the current screen for the next one, and never fail silently.
 *
 * A tapped button that produces no visible change at all is the worst outcome
 * here: the traveller cannot tell a broken bot from a slow one. So the screen
 * gets three chances — edited in place, sent as a new message, then sent again
 * with the formatting stripped, since an unbalanced `_` or `*` in a note the
 * screen quotes is enough for Telegram to reject the same text twice — and if
 * none of them land, the reason itself goes into the chat.
 */
async function editView(ctx: Context, view: View) {
  try {
    await ctx.editMessageText(view.text, {
      reply_markup: view.keyboard,
      ...(view.markdown ? { parse_mode: "Markdown" as const } : {}),
      link_preview_options: { is_disabled: !view.preview },
    });
    return;
  } catch {
    // The message is too old to edit, or nothing about it changed. Either way
    // the traveller still needs to see the screen they asked for.
  }

  try {
    await sendView(ctx, view);
    return;
  } catch (err) {
    if (!view.markdown) {
      await reportViewFailure(ctx, err);
      return;
    }
  }

  try {
    await sendView(ctx, { ...view, markdown: false });
  } catch (err) {
    await reportViewFailure(ctx, err);
  }
}

async function reportViewFailure(ctx: Context, err: unknown) {
  console.error("could not show a /manage screen", err);
  await ctx
    .reply(
      `⚠️ I couldn't show that screen: ${err instanceof Error ? err.message : "unknown error"}\n\n` +
        `Nothing was changed. /manage starts again.`,
      { link_preview_options: { is_disabled: true } },
    )
    .catch(() => {});
}

/**
 * What the webhook must be subscribed to. Telegram's own default is wider than
 * this, but a webhook registered with an explicit list keeps whatever list it
 * was given — including one that forgot `callback_query` and so drops every
 * button tap in silence.
 */
const WEBHOOK_UPDATES = [
  "message",
  "edited_message",
  "callback_query",
  "my_chat_member",
] as const;

/**
 * Make sure Telegram is actually sending us button taps, and put it right if
 * not.
 *
 * The subscription lives on Telegram's side, not in this repository: it is
 * whatever the last `setWebhook` call said, months ago, from a shell. Nothing a
 * deploy does can change it. So a webhook registered with an `allowed_updates`
 * list that predates the `/manage` keyboard keeps delivering messages happily
 * while dropping every tap before it leaves Telegram — and no amount of fixing
 * the handler helps, because the handler is never reached. That is invisible
 * from the chat, and it survives exactly the kind of "fixed it, still broken"
 * loop that costs an afternoon.
 *
 * `/diag fix` says the same thing out loud, but it has to be run by the owner
 * who already knows to suspect this. Doing it here means the deploy that ships
 * a new kind of update also subscribes to it.
 *
 * A missing `allowed_updates` is Telegram's default, which already includes
 * everything we want — so it is left alone, and this only ever writes when the
 * list is present and short. That makes it converge after one call rather than
 * re-registering on every cold start.
 */
export async function ensureTapsDelivered(bot: Bot): Promise<"ok" | "repaired"> {
  const info = await bot.api.getWebhookInfo();
  const allowed = info.allowed_updates;
  if (!allowed || WEBHOOK_UPDATES.every((u) => allowed.includes(u))) return "ok";

  // The URL Telegram already has, not one built from an env var: this deploy is
  // not necessarily the one the webhook points at, and pointing it here would
  // be a much bigger change than the one being made.
  await bot.api.setWebhook(info.url || `${env.appOrigin}/api/telegram`, {
    secret_token: env.telegramWebhookSecret,
    allowed_updates: [...WEBHOOK_UPDATES],
  });

  // Say so, or the repair is as invisible as the fault was. The owner is the
  // one who has been tapping buttons that did nothing.
  await bot.api
    .sendMessage(
      env.ownerTelegramId,
      `🔧 Telegram was only delivering: ${allowed.join(", ")}.\n\n` +
        `Button taps were being dropped before they reached the bot, which is why ` +
        `/manage buttons hung on "Loading…". Fixed — it now delivers ` +
        `${WEBHOOK_UPDATES.join(", ")}.\n\nSend /manage and tap a day.`,
    )
    .catch(() => {});

  return "repaired";
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

_Most of these open a keyboard — /trip is the hub, and every screen carries the next step as a button._

*Trip setup*
/newtrip Name | 2026-08-01 — end date optional, add it with | 2026-08-10
/trip — status, and buttons for everything below
/trips — tap a trip to switch to it (a finished one reopens)
/day — pick the day uploads land on, from every day the trip has
/day 3, /day3, /nextday, /previousday — same, without the picker

*Changing a trip*
/renametrip New name
/dates 2026-08-01 | 2026-08-12
/reminders — on or off, per trip
/regeneratelink — new family link, old one dies
/endtrip — mark it finished; pages stay, uploads stop
/deletetrip — pick one and confirm; erases it and its photos, forever

*During the trip* (everything lands on the current /day)
• Komoot share link → route imported
• GPX or FIT file → route imported (several merge into one day)
• Photos with captions → day gallery, pinned on the map
• Send a photo *as a file* (Telegram: "…" → Send as File) and its own GPS is
  used, so photos uploaded in the evening still land where you took them
• Send an edited version as a file later and I recognise the shot: it replaces
  the one already on the trip, on its own day, no /replace needed
• Any other text → journal entry

*Oops*
Every confirmation carries a 🗑 button — one tap takes that thing back off
/undo — remove the last thing added
Reply /delete to one of my messages — removes that one
/manage — browse the trip and delete anything on it, however old: notes,
photos, tracks, and guestbook messages the family left
/replace — swap the picture behind a photo: pick it, send the new one. Caption,
map pin and place in the day all stay — handy after running a filter over them
/clearday — pick a day and empty it: every note, photo and track on it

*Live*
🔴 Paste a Garmin LiveTrack link → live banner for 24h
/live — what the family page is showing right now
/live off — take the banner down

*Plan*
• A *planned* Komoot tour link → grey plan line + progress
• GPX with caption "plan" → same
/refreshplan — re-sync plan links after editing in Komoot
/refreshweather — fill in weather for older days
/refreshphotos — put photos on the map that arrived before their track
/compressphotos — shrink oversized photos uploaded before compression existed

*Tools*
/merge "Tour Name" url1 url2 ... — fetch Komoot tours, merge by time, send GPX
/mergegpx "Tour Name" — merge your recent GPX uploads (last hour) into one GPX

*Looking back*
/mypage — your permanent page with every trip on it
/archive — download this trip as a self-contained file

/invite — invite code for a friend (valid 7 days)
/diag — buttons not responding? this says whether Telegram is delivering taps

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

function remindersMessage(on: boolean): string {
  return on
    ? "🔔 Reminders on — I'll ping this chat quietly when a day has no track."
    : "🔕 Reminders off for this trip. Everything else works as before.";
}

/** tripDayCount is Infinity for a trip with no end date yet — /day is unbounded until /endtrip. */
function dayRange(max: number): string {
  return Number.isFinite(max) ? `1–${max}` : "1 or more";
}

/**
 * Make this trip the one uploads land on. Picking a finished trip is how you
 * reopen one that ended too early, so that is what tapping it does.
 */
async function activateTrip(chatId: number, trip: DbTrip): Promise<DbTrip> {
  if (trip.finished_at) {
    await reopenTrip(trip);
    return { ...trip, finished_at: null };
  }
  await setActiveTrip(chatId, trip.id);
  return trip;
}

/** Switch, then show where that trip stands — the screen you wanted anyway. */
async function tripSwitchedView(chatId: number, trip: DbTrip): Promise<View> {
  const wasFinished = trip.finished_at !== null;
  const active = await activateTrip(chatId, trip);
  const view = await tripStatusView(active);
  return {
    ...view,
    text:
      `✅ Active trip: *${escapeMd(active.name)}*${wasFinished ? " — reopened, so uploads land here again" : ""}\n\n` +
      view.text,
  };
}

async function switchToTrip(ctx: Context, trip: DbTrip) {
  await sendView(ctx, await tripSwitchedView(ctx.state.chat.chat_id, trip));
}

/**
 * Empty a day and say what went, from either the command or the button.
 *
 * The tally is taken before the deletion, because afterwards there is nothing
 * left to count — and "day 3 is empty" without saying what it held is not a
 * confirmation anyone can check.
 */
async function runClearDay(trip: DbTrip, n: number): Promise<View> {
  const tally = await dayTally(trip, n);
  if (!tally || tallyTotal(tally) === 0) {
    return { text: `Day ${n} has nothing on it.`, keyboard: backToStatus() };
  }
  const what = describeTally(tally);

  try {
    await clearDay(trip, n);
  } catch (err) {
    return {
      text: `⚠️ Clearing day ${n} failed: ${err instanceof Error ? err.message : "unknown error"}. Nothing was removed.`,
      keyboard: backToStatus(),
    };
  }

  // The day's distance was part of what the share card showed.
  await renderOgCard(trip.id).catch(() => {});

  const view = await dayPickerView(trip, 0, "clear");
  return { ...view, text: `🗑️ Day ${n} is empty — ${what} removed.\n\n${view.text}` };
}

/**
 * The two ways out of a GPX merge session, offered on every message that is
 * part of one — so "what do I send now?" never needs answering from memory.
 */
function mergeSessionKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Finish & merge", encodeAction({ type: "mergefinish" }))
    .text("✖️ Cancel", encodeAction({ type: "mergecancel" }));
}

/** Stitch the session's uploads into one GPX and send it back as a file. */
async function finishGpxMerge(ctx: Context) {
  const chatId = ctx.chat!.id;
  const { data: session } = await supabase()
    .from("gpx_merge_sessions")
    .select("name, tracks")
    .eq("chat_id", chatId)
    .maybeSingle();

  if (!session) {
    await ctx.reply('No GPX merge session open here. Start one with /mergegpx "Tour Name".');
    return;
  }

  const tracks = (session.tracks ?? []) as { points?: TrackPoint[]; sport?: string }[];
  if (tracks.length < 2) {
    await ctx.reply("Need at least 2 GPX files in session. Upload more first.", {
      reply_markup: mergeSessionKeyboard(),
    });
    return;
  }

  const allPoints: TrackPoint[] = [];
  for (const t of tracks) allPoints.push(...(t.points ?? []));

  const hasTime = allPoints.every((p) => p.time !== undefined);
  if (hasTime) allPoints.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));

  computeStats(allPoints);
  const gpx = toGpx(session.name, [allPoints]);

  await supabase().from("gpx_merge_sessions").delete().eq("chat_id", chatId);

  await ctx.replyWithDocument(
    new InputFile(Buffer.from(gpx), `${session.name.replace(/[^a-z0-9_-]/gi, "_")}.gpx`),
    {
      caption: `✅ Merged ${tracks.length} GPX file(s) into ${session.name} (${(gpx.length / 1024).toFixed(1)} KB)`,
    },
  );
}

async function cancelGpxMerge(ctx: Context) {
  const { data: removed } = await supabase()
    .from("gpx_merge_sessions")
    .delete()
    .eq("chat_id", ctx.chat!.id)
    .select("name");
  await ctx.reply(
    removed && removed.length > 0
      ? `✖️ Merge session dropped. The uploaded files stay where they were.`
      : "No GPX merge session open here.",
  );
}

/** Erase a trip, then come back with what is left in the chat. */
async function runDeleteTrip(chat: DbChat, trip: DbTrip): Promise<View> {
  try {
    await deleteTrip(trip);
  } catch (err) {
    return {
      text: `⚠️ Delete failed: ${err instanceof Error ? err.message : "unknown error"}. Nothing was removed.`,
      keyboard: new InlineKeyboard().text("🎒 Trips", encodeAction({ type: "trips" })),
    };
  }

  const trips = await listTrips(chat.chat_id);
  const active = chat.active_trip_id === trip.id ? null : chat.active_trip_id;
  const view = tripPickerView(trips, active, "use");
  return { ...view, text: `🗑️ ${trip.name} is gone, photos and all.\n\n${view.text}` };
}

/** The traveller page link, and the one tap that replaces it. */
async function myPageLinkView(ctx: Context, confirmed: boolean): Promise<View> {
  const { senderId, isRegistered } = ctx.state;
  if (!isRegistered) {
    return { text: "Only invited travellers have a page.", keyboard: new InlineKeyboard() };
  }
  if (!confirmed) return myPageConfirmView();

  const slug = slugId(20);
  await supabase().from("users").update({ traveler_slug: slug }).eq("telegram_id", senderId);
  return {
    text: `🔗 Old page link is dead. New one:\n${env.appOrigin}/traveler/${slug}`,
    keyboard: new InlineKeyboard(),
  };
}

/**
 * Shared body of /day <n>, /dayN, /nextday, /previousday: n is assumed to
 * already be a valid integer within [1, max] — callers handle their own
 * usage/boundary messaging before reaching here. The neighbours ride along on
 * the confirmation, so the next day is a tap rather than another command.
 */
async function setCurrentDay(ctx: Context, trip: DbTrip, n: number) {
  const day = await ensureDay(trip, n);
  await updateTrip(trip.id, { current_day_number: n });
  await ctx.reply(`📅 Day ${n} (${day.date}) is now current — uploads land here.`, {
    reply_markup: dayNavKeyboard(trip, n),
  });
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
  // Photos uploaded before this track had nothing to match against.
  const pinned = await backfillPhotoLocations(day.id);

  const { count } = await supabase()
    .from("track_segments")
    .select("*", { count: "exact", head: true })
    .eq("day_id", day.id);

  const parts = [
    `✅ Saved to *day ${day.day_number}*${track.name ? ` — ${escapeMd(track.name)}` : ""}`,
    `📏 ${km(track.stats.distanceM)} km  ⛰️ ${Math.round(track.stats.elevationUp)} m up`,
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

/** Bot API caps downloads well below what a full-resolution photo can weigh. */
const TELEGRAM_DOWNLOAD_LIMIT = 20 * 1024 * 1024;

type PhotoLocation = { lat: number; lng: number; source: "exif" | "track" };

/**
 * Places a photo on the map. A camera's own GPS fix is exact and always wins;
 * otherwise we fall back to matching a timestamp against the day's track,
 * preferring the EXIF capture time over the moment the message was sent.
 */
async function locatePhoto(
  dayId: string,
  exif: ExifData,
  sentAtMs: number,
): Promise<PhotoLocation | null> {
  if (exif.lat !== undefined && exif.lng !== undefined) {
    return { lat: exif.lat, lng: exif.lng, source: "exif" };
  }
  const { data: segments } = await supabase()
    .from("track_segments")
    .select("geojson")
    .eq("day_id", dayId);
  const tracks = (segments ?? []).map((s) => fromGeoJson(s.geojson as TrackGeoJson));
  const hit = matchPhotoToDay(exif.takenAtMs ?? sentAtMs, tracks);
  return hit ? { ...hit, source: "track" } : null;
}

/**
 * A track often arrives after the photos it belongs to — someone shoots all
 * day and uploads the ride in the evening. Those photos were saved with no
 * position, so give them one now. Only untouched rows are considered, which
 * leaves an exact EXIF fix alone.
 */
async function backfillPhotoLocations(dayId: string): Promise<number> {
  const { data: pending } = await supabase()
    .from("media")
    .select("id, telegram_date, taken_at")
    .eq("day_id", dayId)
    .is("matched_lat", null);
  if (!pending || pending.length === 0) return 0;

  const { data: segments } = await supabase()
    .from("track_segments")
    .select("geojson")
    .eq("day_id", dayId);
  const tracks = (segments ?? []).map((s) => fromGeoJson(s.geojson as TrackGeoJson));
  if (tracks.length === 0) return 0;

  let filled = 0;
  for (const photo of pending) {
    const at = Date.parse(photo.taken_at ?? photo.telegram_date);
    if (Number.isNaN(at)) continue;
    const hit = matchPhotoToDay(at, tracks);
    if (!hit) continue;
    const { error } = await supabase()
      .from("media")
      .update({ matched_lat: hit.lat, matched_lng: hit.lng, location_source: "track" })
      .eq("id", photo.id);
    if (!error) filled++;
  }
  return filled;
}

/** Beyond this a first auto-match would spend longer indexing than anyone will wait. */
const TWIN_INDEX_LIMIT = 200;

/**
 * Every photo on the trip with a fingerprint, computing the missing ones as it
 * goes. Hashes are read off the stored thumbnail — 20 kB rather than a whole
 * picture, and a difference hash gives the same answer either way.
 */
async function hashedTripPhotos(tripId: string): Promise<HashedPhoto[]> {
  const { data: days } = await supabase().from("days").select("id").eq("trip_id", tripId);
  const dayIds = (days ?? []).map((d) => d.id);
  if (dayIds.length === 0) return [];

  const { data: photos } = await supabase()
    .from("media")
    .select("id, phash, thumb_path, storage_path")
    .in("day_id", dayIds)
    .limit(TWIN_INDEX_LIMIT);
  if (!photos) return [];

  const store = supabase().storage.from("photos");
  const hashed: HashedPhoto[] = [];
  for (const photo of photos) {
    if (photo.phash) {
      hashed.push({ id: photo.id, hash: photo.phash });
      continue;
    }
    try {
      const { data: blob } = await store.download(photo.thumb_path ?? photo.storage_path);
      if (!blob) continue;
      const hash = await perceptualHash(await blob.arrayBuffer());
      // Keep it, so the trip only pays this once per photo.
      await supabase().from("media").update({ phash: hash }).eq("id", photo.id);
      hashed.push({ id: photo.id, hash });
    } catch {
      // A photo we cannot read simply isn't a candidate.
    }
  }
  return hashed;
}

interface TwinPhoto {
  mediaId: string;
  dayNumber: number;
  caption: string | null;
  distance: number;
}

/**
 * The photo already on the trip that this file is an edited version of, if
 * there is one beyond doubt.
 */
async function findEditedOriginal(tripId: string, hash: string): Promise<TwinPhoto | null> {
  const match = findTwin(hash, await hashedTripPhotos(tripId));
  if (!match) return null;

  const { data: row } = await supabase()
    .from("media")
    .select("id, caption, days(day_number)")
    .eq("id", match.id)
    .maybeSingle();
  if (!row) return null;

  const day = (row as unknown as { days: { day_number: number } | null }).days;
  if (!day) return null;
  return {
    mediaId: match.id,
    dayNumber: day.day_number,
    caption: row.caption,
    distance: match.distance,
  };
}

/**
 * Writes a camera's own fix onto an existing photo. Returns whether it did.
 * An exact fix beats both an empty position and one inferred off the track, so
 * this is the one case where a replacement is allowed to move a pin.
 */
async function applyExifLocation(mediaId: string, exif: ExifData): Promise<boolean> {
  if (exif.lat === undefined || exif.lng === undefined) return false;
  const { error } = await supabase()
    .from("media")
    .update({
      matched_lat: exif.lat,
      matched_lng: exif.lng,
      location_source: "exif",
      ...(exif.takenAtMs ? { taken_at: new Date(exif.takenAtMs).toISOString() } : {}),
    })
    .eq("id", mediaId);
  return !error;
}

interface IncomingPhoto extends ImageDocument {
  fullFileId: string;
  thumbFileId: string | null;
  /** Already downloaded by the caller — a 20 MB file is not worth fetching twice. */
  bytes?: ArrayBuffer;
}

async function savePhoto(
  ctx: Context,
  bot: Bot,
  trip: DbTrip,
  day: { id: string; day_number: number },
  incoming: IncomingPhoto,
) {
  const id = nanoid(8);
  const base = `${trip.id}/day-${day.day_number}/${id}`;
  const store = supabase().storage.from("photos");

  const fullBuf = incoming.bytes ?? (await downloadTelegramFile(bot, incoming.fullFileId));
  // Read the metadata off the original, before anything re-encodes it away.
  const exif = incoming.keepsExif ? readExif(fullBuf) : {};

  // Fingerprint the picture so a later edited export can find its way back to
  // this row instead of landing beside it.
  const phash = await perceptualHash(fullBuf).catch(() => null);

  let fullPath: string;
  let thumbPath: string | null = null;
  if (fullBuf.byteLength > COMPRESS_ABOVE_BYTES) {
    // A camera original is far more picture than a browser needs. Store a
    // screen-sized copy and make our own thumbnail, which beats the 320 px one
    // Telegram attaches to a document.
    const web = await compressForWeb(fullBuf);
    fullPath = `${base}.jpg`;
    const up = await store.upload(fullPath, web.display, { contentType: "image/jpeg" });
    if (up.error) throw up.error;
    thumbPath = `${base}-thumb.jpg`;
    const upThumb = await store.upload(thumbPath, web.thumb, { contentType: "image/jpeg" });
    if (upThumb.error) thumbPath = null;
  } else {
    fullPath = `${base}${incoming.extension}`;
    const up = await store.upload(fullPath, fullBuf, { contentType: incoming.contentType });
    if (up.error) throw up.error;

    if (incoming.thumbFileId && incoming.thumbFileId !== incoming.fullFileId) {
      const thumbBuf = await downloadTelegramFile(bot, incoming.thumbFileId);
      thumbPath = `${base}-thumb.jpg`;
      const upThumb = await store.upload(thumbPath, thumbBuf, { contentType: "image/jpeg" });
      if (upThumb.error) thumbPath = null;
    }
  }

  const sentAtMs = ctx.message!.date * 1000;
  const located = await locatePhoto(day.id, exif, sentAtMs);

  const { senderId, senderName } = ctx.state;
  const { data: inserted, error } = await supabase()
    .from("media")
    .insert({
      day_id: day.id,
      storage_path: fullPath,
      thumb_path: thumbPath,
      caption: ctx.message!.caption ?? null,
      telegram_date: new Date(sentAtMs).toISOString(),
      taken_at: exif.takenAtMs ? new Date(exif.takenAtMs).toISOString() : null,
      matched_lat: located?.lat ?? null,
      matched_lng: located?.lng ?? null,
      location_source: located?.source ?? null,
      phash,
      author_telegram_id: senderId,
      author_name: senderName,
    })
    .select("id")
    .single();
  if (error) throw error;

  const where =
    located?.source === "exif"
      ? " and pinned where it was taken"
      : located
        ? " and pinned on the map"
        : "";
  const sent = await ctx
    .reply(`📸 Added to day ${day.day_number}${where}.`, {
      reply_markup: undoKeyboard("media", inserted.id, day.day_number),
    })
    .catch(() => undefined);
  await recordAction(ctx, sent, "media", inserted.id);
}

/**
 * Puts new bytes behind the photo a `/replace` button picked, whether they
 * arrived compressed or as a file. The day never changes — a replacement is
 * the same picture, edited, not a new one.
 *
 * The pin does change in one direction: a replacement sent as a file can carry
 * the GPS fix the compressed original never had, and refusing to use it would
 * mean re-uploading a whole day's Lightroom exports and still having nothing on
 * the map. An exact fix therefore fills in or upgrades the position; a
 * replacement without one leaves whatever was there alone.
 */
async function swapPendingPhoto(
  ctx: Context,
  trip: DbTrip,
  pending: { mediaId: string; dayNumber: number },
  files: ReplacementFiles,
  exif: ExifData = {},
  /** Whether a person picked this photo or the bot recognised it. */
  how: "picked" | "recognised" = "picked",
) {
  try {
    const swapped = await replacePhoto(pending.mediaId, files);
    await clearReplacement(ctx.chat!.id);

    if (!swapped) {
      await ctx.reply(
        `⚠️ That photo was deleted while I was waiting for the new one, so I left ` +
          `this picture out rather than putting it somewhere you didn't ask for.\n\n` +
          `/replace starts again.`,
      );
      return;
    }

    const pinned = await applyExifLocation(pending.mediaId, exif);

    // A share card built from a photo is now built from the old one.
    await renderOgCard(trip.id).catch(() => {});

    // Straight back to the day's photos: swapping one is rarely the whole job —
    // a filter run over a trip means doing this a dozen times, and the next one
    // should be one tap away rather than another /replace.
    const view = await replaceDayView(trip, pending.dayNumber, 0);
    const swap =
      how === "recognised"
        ? `🔍 Recognised as a photo already on *day ${pending.dayNumber}* and swapped in`
        : `🔄 Photo swapped on day ${pending.dayNumber}`;
    const headline = pinned ? `${swap} — 📍 pinned where it was taken.` : `${swap}.`;
    await sendView(ctx, { ...view, text: `${headline}\n\n${view.text}` });
  } catch (err) {
    await clearReplacement(ctx.chat!.id);
    await ctx.reply(
      `⚠️ Swapping that photo failed: ${err instanceof Error ? err.message : "unknown error"}\n\n` +
        `The old picture is untouched. /replace starts again.`,
    );
  }
}

/** Photos sent as files keep their EXIF, which is the whole point of this path. */
async function savePhotoDocument(
  ctx: Context,
  bot: Bot,
  doc: { file_id: string; file_size?: number; thumbnail?: { file_id: string } },
  image: ImageDocument,
) {
  const trip = await requireTrip(ctx);
  if (!trip) return;

  if ((doc.file_size ?? 0) > TELEGRAM_DOWNLOAD_LIMIT) {
    await ctx.reply(
      "That photo is over 20 MB, which Telegram won't let me download. " +
        "Export it a little smaller and send it again.",
    );
    return;
  }

  const pending = await pendingReplacement(ctx.chat!.id);

  // Editing a trip's photos means sending a lot of them back. Rather than
  // walking the /replace menu each time, recognise the picture: an export of a
  // shot already on the trip goes back where that shot lives, on its own day,
  // keeping its caption and its place. Only files get this — a compressed
  // re-send is more likely a second look at the same view than an edit of it.
  let twin: TwinPhoto | null = null;
  let phash: string | null = null;
  const original = await downloadTelegramFile(bot, doc.file_id);
  const exif = image.keepsExif ? readExif(original) : {};

  if (!pending) {
    phash = await perceptualHash(original).catch(() => null);
    if (phash) twin = await findEditedOriginal(trip.id, phash);
  }

  const target = pending ?? (twin ? { mediaId: twin.mediaId, dayNumber: twin.dayNumber } : null);
  if (target) {
    const caption = ctx.message?.caption ?? null;
    const files: ReplacementFiles =
      original.byteLength > COMPRESS_ABOVE_BYTES
        ? await (async () => {
            const web = await compressForWeb(original);
            return { full: web.display, thumb: web.thumb, caption, phash };
          })()
        : {
            full: original,
            thumb: doc.thumbnail ? await downloadTelegramFile(bot, doc.thumbnail.file_id) : null,
            caption,
            format: { extension: image.extension, contentType: image.contentType },
            phash,
          };
    await swapPendingPhoto(ctx, trip, target, files, exif, pending ? "picked" : "recognised");
    return;
  }

  const day = await requireDay(ctx, trip);
  if (!day) return;

  try {
    await savePhoto(ctx, bot, trip, day, {
      fullFileId: doc.file_id,
      // Telegram generates a preview for image documents; reuse it for the grid.
      thumbFileId: doc.thumbnail?.file_id ?? null,
      bytes: original,
      ...image,
    });
  } catch (err) {
    await ctx.reply(`⚠️ Photo upload failed: ${err instanceof Error ? err.message : "unknown error"}`);
  }
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
    .reply(`📝 Noted for day ${day.day_number}.`, {
      reply_markup: undoKeyboard("note", inserted.id, day.day_number),
    })
    .catch(() => undefined);
  await recordAction(ctx, sent, "note", inserted.id);
}

export function createBot(): Bot {
  const bot = new Bot(env.telegramBotToken);

  bot.use(async (ctx, next) => {
    let state: BotState | null;
    try {
      state = await authorize(ctx);
    } catch (err) {
      // Looking the sender up is itself a database call, and a button tap is
      // waiting on an answer from the moment it is made. Letting this throw
      // past grammy left Telegram's "Loading…" bar running over the chat with
      // nothing to explain it — the one failure mode with no visible trace.
      console.error("could not authorize update", err);
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery("Database unreachable — try again.").catch(() => {});
      }
      return;
    }

    if (!state) {
      // Staying quiet is right for a message from a chat we do not serve, but
      // a refusal still has to end the bar — just not out loud.
      if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
      return;
    }
    ctx.state = state;
    await next();
  });

  const helpKeyboard = () =>
    new InlineKeyboard()
      .text("🎒 Trip", encodeAction({ type: "status" }))
      .text("📅 Days", encodeAction({ type: "days", page: 0, mode: "set" }))
      .row()
      .text("🗂️ Manage", encodeAction({ type: "home" }))
      .text("🎒 Switch trip", encodeAction({ type: "trips" }));

  const help = (ctx: Context) =>
    ctx.reply(HELP, { parse_mode: "Markdown", reply_markup: helpKeyboard() });
  bot.command("start", help);
  bot.command("help", help);

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
        `Next: pick the day below, then send tracks. Optional: send planned Komoot links for the grey plan line.`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text("📅 Start on day 1", encodeAction({ type: "setday", dayNumber: 1 }))
          .text("📅 All days", encodeAction({ type: "days", page: 0, mode: "set" })),
      },
    );
  });

  bot.command("trips", async (ctx) => {
    const { chat } = ctx.state;
    const trips = await listTrips(chat.chat_id);
    await sendView(ctx, tripPickerView(trips, chat.active_trip_id, "use"));
  });

  // Kept for the number people already have in their fingers; without one, the
  // list of trips is itself the picker.
  bot.command("usetrip", async (ctx) => {
    const { chat } = ctx.state;
    const trips = await listTrips(chat.chat_id);
    const idx = parseInt((ctx.match as string).trim(), 10) - 1;
    const trip = trips[idx];
    if (!trip) {
      await sendView(ctx, tripPickerView(trips, chat.active_trip_id, "use"));
      return;
    }
    await switchToTrip(ctx, trip);
  });

  // `/day` on its own opens the picker rather than explaining its own syntax:
  // the days a trip has are the answer to "which day?", and they are already
  // known here.
  bot.command("day", async (ctx) => {
    const trip = await requireTrip(ctx);
    if (!trip) return;
    const arg = (ctx.match as string).trim();
    if (!arg) {
      await sendView(ctx, await dayPickerView(trip, pageOfDay(trip.current_day_number ?? 1), "set"));
      return;
    }
    const n = parseInt(arg, 10);
    const max = tripDayCount(trip);
    if (!Number.isInteger(n) || n < 1 || n > max) {
      const view = await dayPickerView(trip, 0, "set");
      await sendView(ctx, {
        ...view,
        text: `This trip has days ${dayRange(max)}.\n\n${view.text}`,
      });
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
      await ctx.reply(`That trip runs to day ${dayRange(max)} — pick one:`, {
        reply_markup: (await dayPickerView(trip, 0, "set")).keyboard,
      });
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
      await ctx.reply(`You're already on the last day (${max}).`, {
        reply_markup: dayNavKeyboard(trip, max),
      });
      return;
    }
    await setCurrentDay(ctx, trip, n);
  });

  bot.hears(/^\/previousday(?:@\w+)?$/i, async (ctx) => {
    const trip = await requireTrip(ctx);
    if (!trip) return;
    const n = (trip.current_day_number ?? 2) - 1;
    if (n < 1) {
      await ctx.reply("You're already on day 1.", { reply_markup: dayNavKeyboard(trip, 1) });
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
      // No day named, or a day this trip hasn't got: the days it does have,
      // with what is on each of them, is the better answer either way.
      await sendView(ctx, await dayPickerView(trip, 0, "clear"));
      return;
    }

    // `/clearday 3 confirm` still works — it is in the older messages this bot
    // has already sent. Without it, the confirmation is a button.
    if (parts[1]?.toLowerCase() !== "confirm") {
      await sendView(ctx, await clearDayConfirmView(trip, n));
      return;
    }

    await sendView(ctx, await runClearDay(trip, n));
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

  /**
   * Swap the picture behind a photo, keeping everything the photo means: its
   * caption, the pin it earned off the day's track, its place in the day and
   * who took it. Re-editing a trip's photos is otherwise a delete-and-resend
   * that throws all of that away and puts the picture back at the end of the
   * day it belonged in the middle of.
   */
  bot.command("replace", async (ctx) => {
    const trip = await requireTrip(ctx);
    if (!trip) return;
    // A half-finished pick from before is not what this tap meant.
    await clearReplacement(ctx.chat!.id);
    await sendView(ctx, await replaceOverview(trip));
  });

  /**
   * Why a button tap did nothing.
   *
   * Everything the bot can say about a tap it never received is nothing, so
   * when the buttons hang there is no way to tell a broken screen from an
   * update Telegram is not sending us at all. This asks Telegram instead:
   * what it is delivering, what it has been failing to deliver, and how far
   * behind it is. The button underneath closes the loop from the other end.
   *
   * `allowed_updates` is the usual culprit. Set once without `callback_query`
   * — by hand, or by a setWebhook call that listed only what it needed at the
   * time — and taps are dropped before they ever leave Telegram, while
   * messages keep working and hide it.
   */
  bot.command("diag", async (ctx) => {
    if (!ctx.state.isOwner) {
      await ctx.reply("Only the owner can run /diag.");
      return;
    }

    let info;
    try {
      info = await ctx.api.getWebhookInfo();
    } catch (err) {
      await ctx.reply(
        `⚠️ Telegram wouldn't say: ${err instanceof Error ? err.message : "unknown error"}`,
      );
      return;
    }

    const wanted = `${env.appOrigin}/api/telegram`;
    const allowed = info.allowed_updates;
    const tapsDelivered = !allowed || allowed.includes("callback_query");

    if ((ctx.match as string).trim().toLowerCase() === "fix") {
      try {
        await ctx.api.setWebhook(info.url || wanted, {
          secret_token: env.telegramWebhookSecret,
          allowed_updates: WEBHOOK_UPDATES,
        });
      } catch (err) {
        await ctx.reply(
          `⚠️ Re-registering failed: ${err instanceof Error ? err.message : "unknown error"}`,
        );
        return;
      }
      await ctx.reply(
        `🔧 Webhook re-registered at ${info.url || wanted}, now delivering: ${WEBHOOK_UPDATES.join(", ")}.\n\n` +
          `Send /manage and tap a day — it should answer this time.`,
      );
      return;
    }

    const lines = [
      "🩺 Webhook",
      `URL: ${info.url || "(none — Telegram is sending nothing anywhere)"}`,
      info.url && info.url !== wanted ? `⚠️ This deploy expects ${wanted}` : null,
      `Delivers: ${allowed ? allowed.join(", ") : "everything (Telegram's default)"}`,
      tapsDelivered
        ? "Button taps: delivered ✅"
        : "Button taps: NOT delivered ❌ — that is why /manage buttons hang. Send /diag fix.",
      `Waiting to be delivered: ${info.pending_update_count}`,
      info.last_error_message
        ? `Last delivery error (${new Date((info.last_error_date ?? 0) * 1000).toISOString()}): ${info.last_error_message}`
        : "No delivery errors on record.",
      "",
      "Tap the button below: if nothing happens, taps are not getting here.",
    ].filter((line): line is string => line !== null);

    // Plain text on purpose — a URL or a Telegram error message is not
    // something to hand to a Markdown parser that can refuse the whole thing.
    await ctx.reply(lines.join("\n"), {
      reply_markup: new InlineKeyboard().text("🔔 Test a button tap", encodeAction({ type: "ping" })),
      link_preview_options: { is_disabled: true },
    });
  });

  bot.on("callback_query:data", async (ctx) => {
    // Answer before anything else.
    //
    // Telegram lays a "Loading…" bar over the whole chat from the moment a
    // button is tapped until this call lands, and gives up on its own after a
    // while. Every screen below costs a database round trip or three, and the
    // delete paths cost more — so the answer used to be spending that budget
    // before saying a word, and anything that threw on the way left the bar
    // running with nothing to show for it.
    //
    // Nothing about the acknowledgement depends on the work succeeding, so it
    // goes first and failures get a visible home instead: a message in the
    // chat, which is also the only place the traveller can see them when the
    // server is somewhere they are not.
    const tappedAt = Date.now();
    await ctx.answerCallbackQuery().catch(() => {});

    const action = parseAction(ctx.callbackQuery.data);
    if (!action) {
      // A button from a deploy ago, or from a message older than the trip it
      // belonged to.
      await ctx.reply("That button is out of date — send /manage again.").catch(() => {});
      return;
    }

    // The self-test from /diag, answered before anything that could fail: it
    // exists to say "the tap got here", so it must not depend on a trip, a day
    // or a single database read.
    if (action.type === "ping") {
      await ctx
        .reply(
          `✅ Button taps reach the bot — answered in ${Date.now() - tappedAt} ms.\n\n` +
            `So if a /manage button leaves the chat loading, the tap is not being ` +
            `delivered at all. /diag says what Telegram thinks of the webhook.`,
        )
        .catch(() => {});
      return;
    }

    try {
      const { chat } = ctx.state;

      // The screens that exist precisely because there is no active trip, or
      // because what they act on is not one — they run before that check.
      switch (action.type) {
        case "trips":
        case "deletetrips": {
          const trips = await listTrips(chat.chat_id);
          await editView(
            ctx,
            tripPickerView(trips, chat.active_trip_id, action.type === "trips" ? "use" : "delete"),
          );
          return;
        }
        case "usetrip":
        case "deletetrip": {
          // Look the trip up in this chat's own list: a button carries an id and
          // nothing else, and one from another chat's message must not resolve.
          const trips = await listTrips(chat.chat_id);
          const picked = trips.find((t) => t.id === action.id);
          if (!picked) {
            await editView(ctx, tripPickerView(trips, chat.active_trip_id, "use"));
            return;
          }
          if (action.type === "usetrip") {
            await editView(ctx, await tripSwitchedView(chat.chat_id, picked));
            return;
          }
          if (!(await requireTripManager(ctx, picked))) return;
          if (!action.confirmed) {
            await editView(ctx, deleteTripConfirmView(picked));
            return;
          }
          await editView(ctx, await runDeleteTrip(chat, picked));
          return;
        }
        case "mergefinish":
          await finishGpxMerge(ctx);
          return;
        case "mergecancel":
          await cancelGpxMerge(ctx);
          return;
        case "mypagelink": {
          await editView(ctx, await myPageLinkView(ctx, action.confirmed));
          return;
        }
      }

      const trip = await getActiveTrip(chat);
      if (!trip) {
        await ctx.reply("No active trip in this chat any more — /trips lists them.");
        return;
      }

      let view: View | null = null;
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
        case "days":
          view = await dayPickerView(trip, action.page, action.mode);
          break;
        case "setday": {
          const max = tripDayCount(trip);
          if (action.dayNumber > max) {
            view = await dayPickerView(trip, 0, "set");
            view = { ...view, text: `That trip ends on day ${max}.\n\n${view.text}` };
            break;
          }
          const day = await ensureDay(trip, action.dayNumber);
          await updateTrip(trip.id, { current_day_number: action.dayNumber });
          const moved = { ...trip, current_day_number: action.dayNumber };
          view = await dayPickerView(moved, pageOfDay(action.dayNumber), "set");
          view = {
            ...view,
            text:
              `📅 Day ${action.dayNumber} (${day.date}) is now current — uploads land here.\n\n` +
              view.text,
          };
          break;
        }
        case "status":
          view = await tripStatusView(trip);
          break;
        case "reminders": {
          await updateTrip(trip.id, { reminders_enabled: action.on });
          view = await tripStatusView({ ...trip, reminders_enabled: action.on });
          view = { ...view, text: `${remindersMessage(action.on)}\n\n${view.text}` };
          break;
        }
        case "endtrip": {
          if (!(await requireTripManager(ctx, trip))) return;
          if (!action.confirmed) {
            view = endTripConfirmView(trip);
            break;
          }
          await finishTrip(trip);
          view = await tripFinishedView(trip);
          break;
        }
        case "clearday": {
          view = action.confirmed
            ? await runClearDay(trip, action.dayNumber)
            : await clearDayConfirmView(trip, action.dayNumber);
          break;
        }
        case "liveoff": {
          await updateTrip(trip.id, { live_url: null, live_expires_at: null });
          const off = { ...trip, live_url: null, live_expires_at: null };
          view = await tripStatusView(off);
          view = {
            ...view,
            text: `⚫️ Live banner off. Paste a LiveTrack link to switch it back on.\n\n${view.text}`,
          };
          break;
        }
        case "relink": {
          if (!action.confirmed) {
            view = relinkConfirmView(trip);
            break;
          }
          await updateTrip(trip.id, { share_slug: slugId(16) });
          const updated = (await getTrip(trip.id)) ?? trip;
          view = await tripStatusView(updated);
          view = { ...view, text: `🔗 Old link is dead. New family link below.\n\n${view.text}` };
          break;
        }
        case "replaceHome":
          await clearReplacement(ctx.chat!.id);
          view = await replaceOverview(trip);
          break;
        case "replaceDay":
          // Backing out to the list un-picks whatever was picked: the next
          // photo sent should not land on a choice already navigated away from.
          await clearReplacement(ctx.chat!.id);
          view = await replaceDayView(trip, action.dayNumber, action.page);
          break;
        case "replacePick":
          view = await replacePromptView(trip, action.id, action.dayNumber);
          // Only once the photo is known to still be there and the screen has
          // been built — arming first would leave the chat waiting on a pick
          // it was never shown.
          if (view) {
            await armReplacement(ctx.chat!.id, action.id, action.dayNumber, ctx.state.senderId);
          }
          break;
        case "replaceCancel":
          await clearReplacement(ctx.chat!.id);
          view = await replaceDayView(trip, action.dayNumber, 0);
          break;
      }

      // Both item screens return null for something that has already gone — a
      // double tap, or two people tidying up at once. Fall back to the day, and
      // say why in the message: the toast is spent by now.
      let notice = "";
      if (!view) {
        notice = "That one is already gone.\n\n";
        const dayNumber = "dayNumber" in action ? action.dayNumber : 0;
        // Back to the browser the tap came from. Dropping someone out of
        // /replace into the delete screen would be a bad place to put them by
        // accident, of all the screens to land on.
        view =
          action.type === "replacePick"
            ? await replaceDayView(trip, dayNumber, 0)
            : await dayView(trip, dayNumber, 0);
      }

      await editView(ctx, { ...view, text: notice + view.text });
    } catch (err) {
      console.error("manage callback failed", err);
      await ctx
        .reply(
          `⚠️ That didn't work: ${err instanceof Error ? err.message : "unknown error"}\n\n` +
            `Nothing was changed. /manage starts again.`,
        )
        .catch(() => {});
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
        `_Anyone with this link sees all your trips._`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text(
          "🔗 New link (kills this one)",
          encodeAction({ type: "mypagelink", confirmed: false }),
        ),
      },
    );
  });

  bot.command("newmypage", async (ctx) => {
    const { isRegistered } = ctx.state;
    if (!isRegistered) return;
    await sendView(ctx, myPageConfirmView());
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

  // The trip screen is the hub: everything else about a trip is a tap from here.
  bot.command("trip", async (ctx) => {
    const trip = await requireTrip(ctx);
    if (!trip) return;
    await sendView(ctx, await tripStatusView(trip));
  });

  bot.command("endtrip", async (ctx) => {
    const trip = await requireTrip(ctx);
    if (!trip) return;
    if (!(await requireTripManager(ctx, trip))) return;
    await sendView(ctx, endTripConfirmView(trip));
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
      await sendView(ctx, tripPickerView(trips, chat.active_trip_id, "delete"));
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
    // Plain text: the session name is Garmin's, not something we can escape for.
    await ctx.reply(lines.join("\n"), {
      link_preview_options: { is_disabled: true },
      reply_markup: new InlineKeyboard()
        .text("⚫️ Take the banner down", encodeAction({ type: "liveoff" }))
        .row()
        .text("🎒 Trip", encodeAction({ type: "status" })),
    });
  });

  bot.command("reminders", async (ctx) => {
    const trip = await requireTrip(ctx);
    if (!trip) return;
    const arg = (ctx.match as string).trim().toLowerCase();
    if (arg !== "on" && arg !== "off") {
      await ctx.reply(
        `Reminders for *${escapeMd(trip.name)}* are *${trip.reminders_enabled ? "on" : "off"}*.`,
        {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard()
            .text("🔔 On", encodeAction({ type: "reminders", on: true }))
            .text("🔕 Off", encodeAction({ type: "reminders", on: false })),
        },
      );
      return;
    }
    await updateTrip(trip.id, { reminders_enabled: arg === "on" });
    await ctx.reply(remindersMessage(arg === "on"), {
      reply_markup: new InlineKeyboard().text(
        arg === "on" ? "🔕 Turn off" : "🔔 Turn on",
        encodeAction({ type: "reminders", on: arg !== "on" }),
      ),
    });
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

  // Killing a link the family already has is worth one deliberate tap.
  bot.command("regeneratelink", async (ctx) => {
    const trip = await requireTrip(ctx);
    if (!trip) return;
    await sendView(ctx, relinkConfirmView(trip));
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
      // No args: finish the open session, or explain how to start one.
      const { data: session } = await supabase()
        .from("gpx_merge_sessions")
        .select("tracks")
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
      await finishGpxMerge(ctx);
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
      `📥 Started GPX merge session for "${name}".\nUpload .gpx files now, then finish below.`,
      { reply_markup: mergeSessionKeyboard() },
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

  // Photos land on the map the moment they arrive, and a later track upload
  // pins whatever was waiting. Days whose track was already in place before
  // that logic existed never got the second chance — this gives it to them.
  bot.command("refreshphotos", async (ctx) => {
    const trip = await requireTrip(ctx);
    if (!trip) return;
    const { data: days } = await supabase()
      .from("days")
      .select("id")
      .eq("trip_id", trip.id)
      .order("day_number");

    let pinned = 0;
    for (const day of days ?? []) pinned += await backfillPhotoLocations(day.id);
    await ctx.reply(
      pinned > 0
        ? `📍 Pinned ${pinned} photo(s) on the map.`
        : "Every photo that can be placed already is — the rest were sent too far from the track to guess.",
    );
  });

  // Photos are stored screen-sized on the way in, but the ones uploaded before
  // that was true are still camera originals — several MB each, and the
  // lightbox pulls the whole thing down before it shows anything.
  bot.command("compressphotos", async (ctx) => {
    const trip = await requireTrip(ctx);
    if (!trip) return;

    const { data: days } = await supabase().from("days").select("id").eq("trip_id", trip.id);
    const dayIds = (days ?? []).map((d) => d.id);
    if (dayIds.length === 0) {
      await ctx.reply("Nothing uploaded to this trip yet.");
      return;
    }
    const { data: photos } = await supabase()
      .from("media")
      .select("id, storage_path, thumb_path")
      .in("day_id", dayIds);
    if (!photos || photos.length === 0) {
      await ctx.reply("No photos on this trip yet.");
      return;
    }

    await ctx.reply("🗜️ Checking photo sizes — this can take a while…").catch(() => {});
    const store = supabase().storage.from("photos");
    let shrunk = 0;
    let before = 0;
    let after = 0;
    let failed = 0;

    for (const photo of photos) {
      try {
        const { data: blob } = await store.download(photo.storage_path);
        if (!blob || blob.size <= COMPRESS_ABOVE_BYTES) continue;
        const original = await blob.arrayBuffer();
        const web = await compressForWeb(original);

        // Write beside the original rather than over it: every cache in front
        // of the bucket keys on the URL, so an overwrite is the one way to keep
        // showing the old bytes.
        const dir = photo.storage_path.slice(0, photo.storage_path.lastIndexOf("/"));
        const base = `${dir}/${nanoid(8)}`;
        const up = await store.upload(`${base}.jpg`, web.display, { contentType: "image/jpeg" });
        if (up.error) throw up.error;
        const upThumb = await store.upload(`${base}-thumb.jpg`, web.thumb, {
          contentType: "image/jpeg",
        });

        const stale = [photo.storage_path, photo.thumb_path].filter(Boolean) as string[];
        const { error } = await supabase()
          .from("media")
          .update({
            storage_path: `${base}.jpg`,
            thumb_path: upThumb.error ? null : `${base}-thumb.jpg`,
          })
          .eq("id", photo.id);
        if (error) throw error;

        // Only once the row points at the new files is the old pair orphaned.
        await store.remove(stale);
        before += blob.size;
        after += web.displayBytes;
        shrunk++;
      } catch {
        failed++;
      }
    }

    if (shrunk === 0) {
      await ctx.reply(
        failed > 0
          ? `Nothing to shrink, and ${failed} photo(s) could not be read.`
          : "Every photo is already web-sized.",
      );
      return;
    }
    await ctx.reply(
      `🗜️ Shrank ${shrunk} photo(s): ${formatBytes(before)} → ${formatBytes(after)}.` +
        (failed > 0 ? `\n⚠️ ${failed} could not be processed and were left alone.` : ""),
    );
  });

  bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    const name = (doc.file_name ?? "").toLowerCase();
    const isGpx = name.endsWith(".gpx");
    const isFit = name.endsWith(".fit");

    if (!isGpx && !isFit) {
      const image = imageDocument(doc.mime_type, name);
      if (image === "unreadable") {
        await ctx.reply(
          "That looks like a HEIC photo. Browsers can't show those, so send it as JPEG — " +
            "in Lightroom pick JPEG on export, or turn on Settings → Camera → Formats → Most Compatible.",
        );
        return;
      }
      if (image) {
        await savePhotoDocument(ctx, bot, doc, image);
        return;
      }
      if (!ctx.state.isGroup) {
        await ctx.reply(
          "I can only read .gpx and .fit tracks, and photos sent as JPEG or PNG files.",
        );
      }
      return;
    }
    if ((doc.file_size ?? 0) > TELEGRAM_DOWNLOAD_LIMIT) {
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
          await ctx.reply(`✅ Added "${doc.file_name}" (${newTracks.length} file(s) in session)`, {
            reply_markup: mergeSessionKeyboard(),
          });
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

    // Telegram already ships several resolutions — use a small one for the grid
    // so the family page stays cheap to load, and the largest for the lightbox.
    const sizes = [...ctx.message.photo].sort((a, b) => a.width - b.width);
    const full = sizes[sizes.length - 1];
    const thumb = sizes.find((s) => s.width >= 320) ?? full;

    // Did a /replace button pick a photo for this one to take the place of?
    // Ahead of the current day on purpose: a replacement belongs to the day of
    // the photo it replaces, which need not be the day uploads are landing on.
    const pending = await pendingReplacement(ctx.chat!.id);
    if (pending) {
      await swapPendingPhoto(ctx, trip, pending, {
        full: await downloadTelegramFile(bot, full.file_id),
        thumb:
          thumb.file_id !== full.file_id ? await downloadTelegramFile(bot, thumb.file_id) : null,
        caption: ctx.message.caption ?? null,
      });
      return;
    }

    const day = await requireDay(ctx, trip);
    if (!day) return;

    try {
      await savePhoto(ctx, bot, trip, day, {
        fullFileId: full.file_id,
        thumbFileId: thumb.file_id,
        extension: ".jpg",
        contentType: "image/jpeg",
        // Telegram re-encodes compressed photos and drops the metadata.
        keepsExif: false,
      });
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

declare module "grammy" {
  interface Context {
    state: BotState;
  }
}
