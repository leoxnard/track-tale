# TrackTale

A private, invite-only trip journal. Travelers feed it through a **Telegram bot** each evening;
family follows along on a **secret no-login link** — a map with day-colored routes, photos,
notes, stats and weather.

## How it works

- Send the bot a **Komoot share link** → the tour (track + official stats) is imported.
- Send a **GPX/FIT file** → parsed directly; several uploads merge into one day.
- Send **photos** (with captions) and **text** → the day's journal; photos are pinned to the
  route by timestamp (Telegram strips GPS EXIF).
- `/day 3` sets which day uploads go to; a silent 3 AM reminder pings you if a day has no track.
- A *planned* Komoot tour link becomes the grey plan underlay + progress %; it re-syncs daily.
- A Garmin LiveTrack link shows a "Live now" banner for 24 h.

## Setup

1. **Supabase**: create a project, run [supabase/schema.sql](supabase/schema.sql) in the SQL
   editor (creates tables + public `photos` bucket).
2. **Telegram**: create a bot via [@BotFather](https://t.me/BotFather); get your user id from
   [@userinfobot](https://t.me/userinfobot).
3. **Env**: copy [.env.example](.env.example) to `.env` and fill everything in.
4. **Webhook** (after deploying):
   ```sh
   curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
     -d "url=$APP_ORIGIN/api/telegram" \
     -d "secret_token=$TELEGRAM_WEBHOOK_SECRET"
   ```
5. **Vercel**: deploy; set the env vars; `vercel.json` schedules the daily cron (01:00 UTC —
   the reminder + plan refresh + live-link expiry).

## Development

```sh
npm run dev        # http://localhost:5173
npm run typecheck
npm test           # vitest, unit tests for the pure ingestion/rendering logic
```

`/preview` renders the family page with fixture data (dev only, no database needed).

Tests cover the parts that have no database or network in them — track maths, the map
projection, Komoot URL parsing, photo/track time matching and Telegram Markdown escaping.
GitHub Actions runs typecheck, tests and a production build on every push and PR.

## Notes

- Komoot ingestion uses Komoot's internal API via the share token. It is unofficial and can
  break at any time — GPX upload is the always-works fallback, by design.
- The bot only answers Telegram users on the allowlist (owner id from env, friends via
  `/invite` codes).

## Commands

| Command | What it does |
|---|---|
| `/newtrip Name \| 2026-08-01 \| 2026-08-10` | create a trip in this chat |
| `/trips`, `/usetrip 2` | list and switch trips; `/usetrip` reopens a finished one |
| `/day 3` | set the day uploads land on |
| `/trip` | status and family link |
| `/renametrip …`, `/dates … \| …` | fix the name or the date range |
| `/reminders on\|off` | per-trip nightly reminder |
| `/endtrip` | mark finished — pages stay, uploads stop |
| `/deletetrip Name` | erase the trip and its photos, irreversibly |
| `/note …` | journal entry (plain text works too) |
| `/undo`, reply `/delete` | remove the last / a specific item |
| `/mypage`, `/newmypage` | permanent page with all trips; new link |
| `/archive` | download the trip as a self-contained bundle |
| `/refreshplan` | re-sync planned Komoot routes |
| `/regeneratelink` | new family link for this trip |
| `/invite` | one-time invite code for a friend, valid 7 days |

Trip-level changes (`/endtrip`, `/deletetrip`, `/renametrip`, `/dates`) are limited to the
traveller who created the trip, so a busy group chat cannot rewrite someone else's journey.

## Friends

An invite makes someone a full traveller, not a guest of yours. Once they have redeemed a
code in a private chat with the bot they can run their own trips **without you present**:

- `/newtrip` in their own private chat, or in their own group with the bot added to it.
- Trips are scoped to the chat they were created in, so yours and theirs never mix — each
  has its own family link, share card and `/archive`.
- `/mypage` gives them their own permanent page collecting every trip they own.
- Their travel companions in that group need no invite at all: a group becomes trusted once
  it contains a trip, and contributions are credited by name.

Any registered traveller can also `/invite` further friends. Codes expire after 7 days if
unused, but there is no cap on how far the circle spreads — the bot has one owner
(`TELEGRAM_OWNER_ID`) and otherwise treats all travellers alike.

## Archives

`/archive` produces a zip that needs neither network nor TrackTale: the map is
inline SVG instead of tiles, elevation charts stay scrubbable via a small
inlined script, photos are local files, and each day is written out as GPX.
Drop the folder on any static host — including your own server — and it works.
