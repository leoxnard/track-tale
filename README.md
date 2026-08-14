# TrackTale

A private, invite-only trip journal. Travelers feed it through a **Telegram bot** each evening;
family follows along on a **secret no-login link** — a map with day-colored routes, photos,
notes, stats and weather.

## How it works

- Send the bot a **Komoot share link** → the tour (track + official stats) is imported.
- Send a **GPX/FIT file** → parsed directly; several uploads merge into one day.
- A stretch **travelled rather than ridden** — a train, a ferry, a bus — is drawn on the map
  hatched like a railway in the day's own colour, and left out of the kilometres ridden, the
  climb and the progress bar; the day's line reads as continuous without the train claiming
  distance nobody pedalled. A GPX says so in its `<type>` (`train`, `ferry`, `bus`), or just
  in its name ("Zugfahrt Aberdeen – Forres"). [scripts/rail-gpx.mjs](scripts/rail-gpx.mjs)
  builds such a file along the *real* line, taken from OpenStreetMap, rather than a straight
  chord between the two stations.
- Send **photos** (with captions) and **text** → the day's journal. Telegram strips GPS EXIF
  from compressed photos, so those are pinned to the route by timestamp; send a photo **as a
  file** instead and its own GPS fix and capture time survive, which puts it exactly where it
  was taken even if you upload the whole day from the hotel. The metadata is read off the
  original; what gets stored is a 2048 px copy, so a 9 MB export doesn't become a 9 MB
  download for everyone opening the page.
- Send an **edited version** of a photo as a file and it is recognised as the same shot — by
  what the picture looks like, not its name — and swapped in on the day it already lives on,
  keeping its caption and its place. Photos are ordered by capture time everywhere they are
  shown, so an evening batch upload still reads in the order it was taken.
- `/day` picks which day uploads go to, from a keyboard of the trip's days; a silent 3 AM
  reminder pings you if a day has no track.
- A *planned* Komoot tour link becomes the grey plan underlay + progress %; it re-syncs daily.
- A Garmin LiveTrack link shows a "Live now" banner for 24 h, with the ride so far drawn on
  the map — including on day one, before any track has been uploaded. Paste it into the chat,
  or let Garmin email it: add the inbound address as a LiveTrack recipient and starting a ride
  turns the banner on by itself, with the bot confirming in the chat which trip it landed on.
  `/live` reports what the server can actually read off Garmin's page, since that is the one
  part of the app nobody can check from the family link. **Switched off by default**: the
  page fetched Garmin on every single render while a link was live, and that request sat
  between a visitor and their map. Set `LIVE_TRACKING=1` to have all of it back — nothing was
  removed, and no migration is involved either way.
- One whole-tour elevation chart shows the plan in grey with each ridden day laid over the
  stretch of route it actually covers, matched by coordinates rather than stacked in
  sequence — so a shortcut or a detour leaves a gap or an overlap instead of shifting every
  day after it. Days are matched to the nearest point *on* the planned line rather than to
  its nearest waypoint, so a plan drawn with few waypoints places a day as accurately as a
  dense one. The axis is distance along the plan, so a day spans the plan it covered rather
  than its own odometer — a day that rides 95 km to advance 86 km of route sits in those
  86 km instead of overhanging its neighbours. What was ridden is in the day's own stats.
- Every day carries the **wind it was ridden into**, as an ordinary **wind rose** — the same
  figure a weather station has drawn for a century, so it reads on sight — with a little
  bicycle in the middle. North is up; each petal is a compass direction the wind blew *from*;
  how far it reaches is how many kilometres were ridden under that wind, with the rings
  labelled so a petal is a number and not just a shape; and each petal is banded by speed
  class from the hub outwards, on Beaufort's boundaries, with a legend naming the classes. The
  only thing changed from the convention is what the rings count: kilometres ridden rather
  than hours observed. The bicycle is ours, and it is the point — it holds the day's average
  heading, so petals crowding its nose *are* a day of headwind and petals behind the saddle
  *are* a day of being pushed along, no number needed. Underneath, the numbers anyway: the mean
  wind and where it came from, gusts, and the day split into kilometres ridden against the
  wind, across it and with it — that last bar in dark-to-pale rather than in colour, because
  the rose already spends colour on strength and a second meaning for the same red an arm's
  length away is how a figure stops being readable. The whole trip gets the same rose at the
  top of the page.
  The wind is measured, not guessed: Open-Meteo's hourly reanalysis at the middle of each
  day's route, matched to the track's own timestamps and interpolated between the hours, then
  weighted by distance rather than time — so an hour in a café with the flags snapping is not
  an hour of headwind. Only pedalled kilometres count; a train has no headwind. Days without
  a clock on the track, or cached before this existed, simply show no ring — `/refreshweather`
  fills them in from the archive.
- Tapping a photo opens it full screen over the page, with arrow keys, on-screen arrows or a
  swipe to run through every photo on the trip.
- A **Cycle routes** button lays the signposted route network over the map — EuroVelo and the
  other international routes in red, national in blue, regional and local paler — from
  [Waymarked Trails](https://cycling.waymarkedtrails.org/), which renders OpenStreetMap's
  route relations as transparent tiles. It sits under the day colours at half strength, so
  it reads as context rather than competing with the ride, and it is **off until asked for**:
  no tile is fetched from a third party while the button is untouched.

## Setup

1. **Supabase**: create a project, run [supabase/schema.sql](supabase/schema.sql) in the SQL
   editor (creates tables + public `photos` bucket).
2. **Telegram**: create a bot via [@BotFather](https://t.me/BotFather); get your user id from
   [@userinfobot](https://t.me/userinfobot).
3. **Env**: copy [.env.example](.env.example) to `.env` and fill everything in. Everything
   is required except `MAPTILER_KEY`, which puts a real map behind the route on the share
   card (without it the card renders on plain paper), and `LIVE_TRACKING`, which is off
   unless you set it to `1`.
4. **Webhook** (after deploying):
   ```sh
   curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
     -d "url=$APP_ORIGIN/api/telegram" \
     -d "secret_token=$TELEGRAM_WEBHOOK_SECRET" \
     -d 'allowed_updates=["message","edited_message","callback_query","my_chat_member"]'
   ```
   `callback_query` is what carries a tap on one of the bot's buttons. Leave it out of
   an explicit `allowed_updates` and the `/manage` keyboard hangs on "Loading…" forever
   while ordinary messages keep working — the handler is never reached, so no amount of
   fixing it helps.

   That subscription lives on Telegram's side and no deploy can change it, so the bot
   checks it itself: once per cold start and again in the nightly cron, it asks Telegram
   what it is delivering and re-registers with the list above if button taps are missing,
   telling the owner in the chat when it did. `/diag` reports the same thing on demand,
   and `/diag fix` forces the re-registration.
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
| `/trips` | every trip as a button — tap one to switch, a finished one reopens |
| `/day` | pick the day uploads land on: every day the trip has, plus the next one |
| `/day 3`, `/nextday`, `/previousday` | same, without the picker |
| `/trip` | status, family link, and buttons for everything else on this list |
| `/renametrip …`, `/dates … \| …` | fix the name or the date range |
| `/reminders` | per-trip nightly reminder, toggled from a button |
| `/endtrip` | mark finished — pages stay, uploads stop |
| `/deletetrip` | pick a trip and confirm; erases it and its photos, irreversibly |
| `/note …` | journal entry (plain text works too) |
| `/undo`, reply `/delete` | remove the last / a specific item |
| `/manage` | browse the trip and delete anything on it — notes, photos, tracks, guestbook messages |
| `/replace` | swap the picture behind a photo, keeping its caption, map pin and place in the day |
| `/clearday` | pick a day and empty it: every note, photo and track on it |
| `/live` | what the live banner is showing, and why; `/live off` takes it down |
| `/mypage`, `/newmypage` | permanent page with all trips; new link |
| `/archive` | download the trip as a self-contained bundle |
| `/refreshplan` | re-sync planned Komoot routes |
| `/refreshphotos` | pin photos that arrived before their day's track |
| `/refreshweather` | fill in weather and wind for older days, from the historical archive |
| `/compressphotos` | shrink photos stored at full camera resolution |
| `/regeneratelink` | new family link for this trip |
| `/invite` | one-time invite code for a friend, valid 7 days |

Trip-level changes (`/endtrip`, `/deletetrip`, `/renametrip`, `/dates`) are limited to the
traveller who created the trip, so a busy group chat cannot rewrite someone else's journey.

Every confirmation the bot sends carries a 🗑 button that opens the confirmation for exactly
that item, so the usual way to take something back off is one tap. `/undo` and a `/delete`
reply both need the bot's confirmation message to still be in the chat, so they only reach
things added recently. `/manage` walks the trip itself — a day picker, then that day's
contents as buttons, then a confirmation — so a photo from last week is as removable as one
from a minute ago. Deleting a photo takes its files out of storage too.
`/clearday` empties a whole day in one go, for a day uploaded against the wrong day number
or built from the wrong files; it lists the days that hold something, asks for a confirmation
first, and leaves the family's guestbook messages alone.

`/replace` is the same browser again, photos only: pick a day, tap a photo, send the new
picture. The row survives the swap, so the caption, the pin the photo earned by matching the
day's track, its place in the day's order and who took it all stay as they were — only the
file changes. That matters when the whole trip's photos come back from an edit: deleting and
re-sending them would strip every caption and drop each one at the end of the day it used to
sit in the middle of. After a swap the day's photo list comes straight back, so working
through a trip is one tap per picture. The new files are written under fresh names rather
than over the old ones, because the page, Telegram's previews and any CDN in between cache by
URL; the old files are removed once the row no longer points at them. A pick expires after an
hour, so a forgotten `/replace` cannot swallow the next photo sent into the chat.

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
