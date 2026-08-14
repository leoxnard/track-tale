import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import { nanoid } from "nanoid";
import { env } from "./env.server";
import { supabase } from "./supabase.server";
import {
  createInvite,
  createTrip,
  deleteTrip,
  ensureDay,
  finishTrip,
  getActiveTrip,
  getTrip,
  lastUsedDayNumber,
  listTrips,
  pruneDaysBeyond,
  realignDayDates,
  tripDayCount,
  updateTrip,
  INVITE_TTL_DAYS,
} from "./db.server";
import { findKomootUrl, parseKomootUrl, mergeKomootTours } from "./komoot";
import { findLiveTrackUrl } from "./live-link";
import { probeLiveSession } from "./livetrack.server";
import { parseFit, parseGpx } from "./gpx";
import { fromGeoJson, type TrackGeoJson } from "./track";
import { transitMode } from "./transport";
import { imageDocument } from "./photo-file";
import { motionFormat } from "./live-photo";
import {
  attachMotionByHand,
  motionUrl,
  saveMotion,
  unpairMotion,
  waitingMotions,
} from "./bot-motion.server";
import { compressForWeb, formatBytes, COMPRESS_ABOVE_BYTES } from "./image.server";
import { renderOgCard } from "./og.server";
import { buildArchive } from "./archive.server";
import { escapeMd, slugId } from "./telegram-md";
import { deleteEntity, ENTITY_LABEL, type EntityType } from "./entities.server";
import { encodeAction, motionCode, parseAction, MOTION_ANY } from "./manage";
import {
  applyDelete,
  confirmView,
  dayNumberOfPhoto,
  dayView,
  motionDayView,
  motionOverview,
  overview,
  replaceDayView,
  replaceOverview,
  replacePromptView,
  type View,
} from "./manage.server";
import { armReplacement, clearReplacement, pendingReplacement } from "./media-replace.server";
import {
  clearDayConfirmView,
  dayNavKeyboard,
  dayPickerView,
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
import {
  downloadTelegramFile,
  editView,
  sendView,
  TELEGRAM_DOWNLOAD_LIMIT,
  WEBHOOK_UPDATES,
} from "./bot-chrome.server";
import {
  authorize,
  requireDay,
  requireTrip,
  requireTripManager,
  type BotState,
} from "./bot-access.server";
import { helpText, LIVE_OFF_NOTICE } from "./bot-help";
import {
  backfillPhotoLocations,
  savePhoto,
  savePhotoDocument,
  swapPendingPhoto,
} from "./bot-photos.server";
import { cacheDayWeather, cacheDayWeatherFromPhotos } from "./day-weather.server";
import {
  ingestKomootUrl,
  refreshPlan,
  saveNote,
  savePlanSegment,
  saveTrackSegment,
} from "./bot-ingest.server";
import {
  cancelGpxMerge,
  dayRange,
  finishGpxMerge,
  mergeSessionKeyboard,
  myPageLinkView,
  remindersMessage,
  runClearDay,
  runDeleteTrip,
  setCurrentDay,
  switchToTrip,
  tripSwitchedView,
} from "./bot-actions.server";

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
    ctx.reply(helpText(), { parse_mode: "Markdown", reply_markup: helpKeyboard() });
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
  /**
   * The videos still waiting for a photo. The button on the bot's own reply is
   * the usual way into this, but that message is scrollback — and a chat that
   * has been cleared, or a video parked yesterday, would otherwise leave the
   * file reachable by nothing at all.
   */
  bot.command("livephoto", async (ctx) => {
    const trip = await requireTrip(ctx);
    if (!trip) return;

    const waiting = await waitingMotions(ctx.chat!.id, trip.id);
    if (waiting.length === 0) {
      // Not a dead end: the other half of this command is fixing a video that
      // did get placed, on the wrong photo.
      await ctx.reply(
        "No Live Photo videos are waiting.\n\n" +
          "Send a photo and the video that came with it and I'll pair them. If one ended up " +
          "on the wrong photo, take it off below and put it where it belongs.",
        {
          reply_markup: new InlineKeyboard().text(
            "🔀 Move one off the wrong photo",
            encodeAction({ type: "motionHome", code: MOTION_ANY }),
          ),
        },
      );
      return;
    }

    const keyboard = new InlineKeyboard();
    for (const motion of waiting) {
      keyboard
        .text(
          `🎬 ${new Date(motion.parkedAtMs).toISOString().slice(0, 16).replace("T", " ")}`,
          encodeAction({ type: "motionHome", code: motionCode(motion.id) }),
        )
        .row();
    }
    keyboard.text("🔀 Move one off the wrong photo", encodeAction({ type: "motionHome", code: MOTION_ANY }));
    await ctx.reply(
      `🎬 ${waiting.length} video(s) waiting for a photo:\n` +
        // The files themselves, so it is possible to tell which is which before
        // choosing — three seconds of somewhere is not identifiable by its
        // timestamp alone.
        waiting.map((m) => motionUrl(m.storagePath)).join("\n") +
        `\n\nPick one, then the photo it belongs to.`,
      { reply_markup: keyboard },
    );
  });

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
        case "motionHome":
          view = await motionOverview(trip, action.code);
          break;
        case "motionDay":
          view = await motionDayView(trip, action.code, action.dayNumber, action.page);
          break;
        case "motionPick": {
          const dayNumber = await dayNumberOfPhoto(trip, action.id);
          // No video in hand: this tap is taking one *off* a photo, and what
          // comes back is the picker for it, now looking for the right one.
          if (action.code === MOTION_ANY) {
            const freed =
              dayNumber !== null && (await unpairMotion(ctx.chat!.id, trip.id, action.id));
            if (!freed) {
              view = await motionOverview(trip, MOTION_ANY);
              view = { ...view, text: `That photo has no video on it.\n\n${view.text}` };
              break;
            }
            view = await motionOverview(trip, motionCode(freed));
            view = {
              ...view,
              text:
                `🔀 Taken off day ${dayNumber}. Now pick the photo it does belong to.\n\n` +
                view.text,
            };
            break;
          }
          const attached =
            dayNumber !== null &&
            (await attachMotionByHand(ctx.chat!.id, trip.id, action.code, action.id));
          if (!attached) {
            // Either the video has already been placed — a second tap on a
            // button still sitting in the chat — or the photo has gone. Say so
            // rather than silently redrawing a screen that looks unchanged.
            view = await motionOverview(trip, action.code);
            view = {
              ...view,
              text: `That video isn't waiting any more — it may already be on a photo.\n\n${view.text}`,
            };
            break;
          }
          // Straight back to the day: placing one video by hand usually means
          // placing the next one too, and the day is where they are.
          view = await motionDayView(trip, action.code, dayNumber, 0);
          view = {
            ...view,
            text: `🎬 Done — that photo on day ${dayNumber} moves now.\n\n${view.text}`,
          };
          break;
        }
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
    if (!env.liveTracking) {
      await ctx.reply(LIVE_OFF_NOTICE);
      return;
    }
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
      .select("id, day_number, date, track_segments(geojson, sport)")
      .eq("trip_id", trip.id)
      .order("day_number");

    await ctx.reply("🌤️ Fetching weather — this can take a moment…").catch(() => {});
    let filled = 0;
    let skipped = 0;
    for (const day of days ?? []) {
      // Every ridden segment, not just the first: the sample sites are spread
      // along what is passed in, and a day split by a lunch stop would otherwise
      // be sampled entirely across its morning. A train leg is left out — where
      // it went says nothing about where the riding was.
      const segments = (
        day as { track_segments: { geojson: TrackGeoJson; sport: string | null }[] }
      ).track_segments.filter((s) => transitMode(s.sport) === null);
      if (segments.length === 0) {
        // No route to follow, but a rest day photographed on a phone knows
        // where it was. Days with neither stay silent rather than counting as
        // unavailable — there was never anything to fetch for them.
        if (await cacheDayWeatherFromPhotos(day, { force: true })) filled++;
        continue;
      }
      const points = segments.flatMap((s) => fromGeoJson(s.geojson));
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
      // A Live Photo's MOV, sent as a file so it keeps its quality. Ahead of
      // the image check because a video is not a picture and would otherwise
      // fall through to "I can only read tracks and photos".
      if (motionFormat(doc.mime_type ?? null, doc.file_name ?? null)) {
        const trip = await requireTrip(ctx);
        if (!trip) return;
        await saveMotion(ctx, bot, trip, {
          fileId: doc.file_id,
          thumbFileId: doc.thumbnail?.file_id ?? null,
          // A document carries no duration; `looksLikeMotion` falls back to size.
          durationS: null,
          fileName: doc.file_name ?? null,
          mimeType: doc.mime_type ?? null,
          fileSize: doc.file_size ?? null,
        });
        return;
      }

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

  // A video is only ever the motion behind a photo here — see bot-motion.
  // `animation` is the same thing arriving soundless, which is what a Live
  // Photo's MOV often becomes once Telegram has re-encoded it.
  bot.on(["message:video", "message:animation"], async (ctx) => {
    const clip = ctx.message.video ?? ctx.message.animation!;
    const trip = await requireTrip(ctx);
    if (!trip) return;
    await saveMotion(ctx, bot, trip, {
      fileId: clip.file_id,
      // The cover frame is what the look-alike match runs on: for a Live Photo
      // it is the photograph itself.
      thumbFileId: clip.thumbnail?.file_id ?? null,
      durationS: clip.duration ?? null,
      fileName: clip.file_name ?? null,
      mimeType: clip.mime_type ?? "video/mp4",
      fileSize: clip.file_size ?? null,
    });
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return; // unknown command, stay quiet

    const liveUrl = findLiveTrackUrl(text);
    const komootUrl = findKomootUrl(text);

    // Links are unambiguous intent, so they work anywhere.
    if (liveUrl) {
      // Saying so beats saving a link the page will not read, and beats filing
      // the message away as a journal note.
      if (!env.liveTracking) {
        await ctx.reply(LIVE_OFF_NOTICE);
        return;
      }
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
