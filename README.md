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
- **Live Photos** from an iPhone keep their motion. Send the photo and send the video that
  came with it — in either order, minutes or days apart — and the bot works out which photo
  the video belongs to **by looking at it**: Telegram attaches a cover frame to every video,
  and for a Live Photo that frame *is* the photograph, so the same fingerprint that
  recognises an edited re-upload recognises the pair, across the whole trip. Where there is
  no cover frame **at all** to go on, it falls back to the last photo sent that hasn't got
  motion yet. A cover frame that matches nothing is not the same as having none: it is the
  answer "none of these", and the order is not allowed to overrule it. A video that
  arrives before its still waits five minutes for one, and will not accept a photo that
  doesn't look like it; several can wait at once.
- When neither the picture nor the order can say which photo a video belongs to — a crop in
  an editor is the usual reason — the video is kept and the bot hands you a **button to pick
  it by hand**: the day, then the photo, listed in the order the family page shows them, so
  "photo 3" is the third one on that day. A photo that already moves is marked, and picking
  it replaces what it had. `/livephoto` finds the waiting videos again later, since a button
  in the scrollback is not somewhere a file should live; anything still unclaimed after a
  week is swept by the nightly cron. The same command **takes a video back off** a photo it
  should never have landed on and hands it straight to the picker. Anything longer than six seconds is treated as a clip and declined,
  because the page has nowhere to show one. Send the video the normal compressed way rather
  than as a file — Telegram re-encodes it to MP4, which every browser plays, whereas the
  untouched `.MOV` off an iPhone is HEVC and plays only on Apple devices.
- Send an **edited version** of a photo as a file and it is recognised as the same shot — by
  what the picture looks like, not its name — and swapped in on the day it already lives on,
  keeping its caption and its place. Photos are ordered by capture time everywhere they are
  shown, so an evening batch upload still reads in the order it was taken.
- `/day` picks which day uploads go to, from a keyboard of the trip's days; a silent 3 AM
  reminder pings you if a day has no track.
- A *planned* Komoot tour link becomes the grey plan underlay + progress %; it re-syncs daily.
- `/route` cuts **the next stretch of that plan** out and sends it as a GPX, so the morning
  no longer starts by importing the whole tour into gpx.studio and scrubbing a cursor along
  it. 130 km by default, changed by a button under the file or by `/route 150`. The cut
  begins where the bot last saw you — the end of your newest track, or your newest located
  photo if that is more recent, and the message names which — and the file *starts at that
  position*, so its first leg is the way back to the planned line rather than a route that
  begins somewhere you are not. In a private chat, simply sending a location (📎 → Location)
  cuts from there with no command at all; in a group, `/route` in reply to a pin does the
  same, since "here's the campsite" is a thing people say to each other. The join back to the
  route is extra rather than counted against the 130, because the kilometres you did not
  choose should not shorten the day, and it is reported so a stale position that lands twenty
  kilometres out is visible rather than silent.
- The cut is taken from **the tour as it was drawn**, not from the copy on the page. What the
  database holds is thinned to a budget, because the family page redraws the whole plan on
  every visit — and a line thinned for drawing is not one a navigation device wants: every
  smoothed bend is a stretch an importer cannot match to a road, which is what shows up in
  Komoot as an off-grid segment. So every planned route is **kept as imported**, at full
  resolution, in a private `plans` bucket, and `/route` cuts from that — for the one or two
  segments the day actually crosses, worked out first from the thinned copy, which is wrong
  about corners but perfectly good at answering *which segment*. Failing that it re-fetches
  from Komoot (which is how plans imported before this fill themselves in, on the next
  `/refreshplan` or overnight), and failing that it cuts the thinned line and says in the
  message that it did. That thinning is now **by shape** — Douglas-Peucker, within a few
  metres — rather than by keeping every nth point, a stride that on a 135 km route with
  hairpins put the line up to 100 m off the road.
- `/supermarkt` (or `/supermarket`) lists **the shops the route passes** — supermarkets and
  corner shops within 300 m of the planned line over the next 50 km, in the order you reach
  them, each with how far along the ride it is, how far off the route it sits, and what
  OpenStreetMap knows of its opening hours. `/supermarkt 25` looks a shorter way ahead, the
  buttons under the list look further, and the 🛒 button under a `/route` file searches from
  the position that file was cut from — which is how a location you sent stays usable, since
  it is never stored. If nothing at all sits within 300 m the search widens once, to 1.5 km,
  and says that it did: "nothing near the route" and "nothing out there" are different days.
  Data is OpenStreetMap through [Overpass](https://overpass-api.de) — no key, no account,
  and the corridor query is native to it, where a places API would only answer for circles
  around a point. Hours are quoted as the map has them rather than interpreted.
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
- Every day carries the **wind it was ridden into**, as a **wind rose** — the figure a weather
  station has drawn for a century, so it reads on sight — with an arrow in the middle marking
  the direction of travel.
  Each petal is a direction the wind blew *from*; how far it reaches is how many kilometres
  were ridden under it, with the rings labelled so a petal is a number and not just a shape;
  and each petal is banded by speed class from the hub outwards, on Beaufort's boundaries,
  with the key printed once, on the trip's own rose at the top of the page.
- Two things are changed from the convention, both on purpose. The rings count **kilometres
  ridden** rather than hours observed. And the rose is turned into the **rider's frame**: up
  is the direction of travel, not north, so a petal's angle is where the wind sat relative to
  the nose — ahead, behind, over one shoulder. That second one is the whole point. Drawn
  around the compass, a lap of a lake is unreadable: a loop has no net heading for the marker
  in the middle to point, so "petals in front of the nose" stops meaning anything on
  exactly the rides where the wind is most obviously half a gift and half a tax. Around the
  rider, that lap draws itself honestly — petals ahead for the quarter ridden into the wind,
  petals behind for the quarter that pushed — and any two days can be compared at a glance.
  Where the wind came from on the map is a fact about the map: it is in the line of text
  under the rose ("19 km/h out of the WSW"), which never needed a picture. Underneath that,
  the day split into kilometres ridden against the wind, across it and with it — that bar in
  dark-to-pale rather than in colour, because the rose already spends colour on strength, and
  a second meaning for the same red an arm's length away is how a figure stops being readable.
- Under a day all of that costs **no room at all**: an arrow and a speed join the line that
  was already there beside the temperature and the rain (`🌧️ 9–11°C · 💧 2.0 mm · ↘ 12 km/h`),
  and the rose opens on a tap. Expanded under every day of a three-week trip it pushed the
  photographs and the writing off the screen, which is the wrong way round — the wind is
  context for a day, not the day. That arrow is in the **rider's frame**, exactly like the one
  on the rose it opens: up is the direction of travel, so an arrow pointing down at you is
  wind in the face and one pointing up is wind at your back. A compass arrow was the first
  version and it answered the wrong question — "north-west" says nothing about a day unless
  you also remember which way the road ran, which is why the rose left the compass in the
  first place. On a ride that met the wind from every side the arrow gives way to a ring,
  since there is no mean angle to point at; both directions are in the tooltip regardless, in
  words. The trip's own rose at the top of the page stays open, since it is the one worth the
  room and the one carrying the key.
- The wind is **measured, not guessed**: Open-Meteo's hourly reanalysis, asked **every 10 km
  along the day's route** rather than only at its middle, so each stretch of riding is
  answered by the reading nearest to it — a hundred-kilometre stage does not have one wind.
  Ten kilometres is about the grid of the finest data behind the answer (ERA5-Land resolves
  ~9 km), so asking more often returns the same numbers rather than better ones; a short day
  keeps a single site, and a very long one spreads its sites wider once it reaches the
  ceiling of 24. However many there are, they cost one request — Open-Meteo answers for a
  list of coordinates at once — and if that list is ever refused the day falls back to its
  midpoint alone rather than losing its weather. Readings are matched to the track's own
  timestamps, interpolated between the hours, and weighted **by distance rather than time**,
  so an hour in a café with the flags snapping is not an hour of headwind. Only pedalled
  kilometres count; a train has no headwind. Worth knowing when reading the figures: wind is
  reported at the meteorological standard of **10 m above ground**, so what a rider felt at
  saddle height, behind hedges and buildings, was typically a good deal less — the direction
  and the headwind/tailwind verdict are the solid part, the exact km/h is a model value. A
  day with no clock on its track, or cached before any of this existed, simply shows no rose;
  `/refreshweather` fills those in from the archive.
- **Temperature and rain come from the same request, over the riding hours only.** The day
  line used to read the calendar day's rainfall total and its min/max temperature at one
  point near the route — both answers to a question nobody asked. Eight millimetres that fell
  between two and five in the morning is a dry day on a bicycle; a minimum of 4°C reached at
  dawn is not the temperature of a ride that started at ten. So the hourly series already
  fetched every 10 km is walked along the track, and only the hours the wheels were turning
  count. The two are handled differently on purpose: a temperature is an instant and may be
  interpolated between hours, while rain is an accumulation over the hour *before* its stamp,
  so a moment falls inside one bucket and gets the share of it the rider spent there. A whole
  day's rain becomes one number — how much fell on them — and that number opens a panel with
  the kilometres ridden wet against dry, the heaviest hour, and what the whole day dropped by
  comparison: a day that saw 14 mm and gave the rider 2 of them is a different day from one
  that gave them all 14. The temperature opens the same way, onto the curve it followed over
  the riding hours, marked at its coldest and warmest — and the range in the line above the
  curve is read off those same hours, not off the interpolated instants between them, so the
  heading and the curve's own two labels always say the same thing. **Only one panel is ever
  open** — these
  sit inside a day's block, and two at once push the next day's photographs down the screen to
  explain the last one's weather. Neither chart puts a clock on anything: the hourly stamps
  are absolute and the trip's timezone is not on the page, so they are shaped by the ride and
  labelled by value. The little weather icon is still the day's sky, not the ride's.
- **A day with no route still gets its weather, from where the photos were taken.** A rest
  day, a day the tracker stayed off, a day somebody only sent pictures — none of them have a
  line for the weather to follow, and they used to show no temperature at all. A photo out of
  a phone carries its own GPS fix, which is all the day card needs: the places the day was
  photographed become the sites, one per weather grid cell, and the shot nearest the middle
  of the day supplies the temperature and the icon. Only a camera's own fix counts — a
  position inferred from a track says nothing the track had not already said. A day that has
  a ridden track keeps the route's answer, which is the better one. `/refreshweather` fills
  in older photo-only days the same way.
- A **Wind** button lays the wind itself over the map: a channel of arrows in lanes either
  side of the route, each pointing the way the wind was blowing *there*, at the hour that
  stretch was ridden, coloured by the same speed classes as the rose's petals and drifting
  along their own direction so the channel reads as weather moving through it. The rose says
  whether the day was work; this says *where* — a day that was half headwind is usually a day
  with one exposed valley in it, and only the map can show that. Like the route network it is
  **off until asked for**, and the animation stops itself when the tab is hidden.
- Nothing about that channel is fixed to the ground. What is stored is a list of samples *on*
  the route — a place, a moment, a wind — and the lanes are laid out fresh every frame from
  one number: how many metres a pixel is currently worth. So the buffer is about **a
  centimetre either side whatever the zoom**, which is kilometres of ground with a whole tour
  on screen and a few hundred metres in a valley, and the arrows are the same distance apart
  on screen throughout. Zoom in and the arrows halfway between the ones already there **fade
  up into place**; zoom out and they fade away again — the sets nest, so zooming only ever
  adds arrows between the others rather than reshuffling them, and no set ever pops in or out
  at one pixel of zoom. The arrows sit **over** the route with a paper-coloured halo, because
  a half-transparent arrow under a 5 px coloured line is simply not there.
- Tapping a photo opens it full screen over the page, with arrow keys, on-screen arrows or a
  swipe to run through every photo on the trip.
- A **Live Photo** moves. In the day's grid, **hold a finger on it** and it plays — without
  the photo opening full screen when you let go, and without iOS's own press-and-hold menu
  appearing over the top. Resting a thumb on a picture and **scrolling on** counts as holding
  it, which is how a day actually gets looked at. A mouse plays it by pointing at it.
  Scrolling one into the middle of the screen plays it once too, which is what makes the
  whole thing findable: nobody holds a finger on a photo to see whether it might move. Full screen, it plays once as it opens
  and then on **a single tap**, on a hold, or from the **Live** badge. A hold starts the clip
  rather than gating it — letting go a moment later would show almost nothing, and three
  seconds is short enough to simply run. The still stays underneath throughout, so a photo
  whose motion is still loading is a photograph rather than an empty tile, and a reader whose
  system asks for reduced motion gets the still and the badge and nothing that moves on its
  own.
- A **Cycle routes** button lays the signposted route network over the map — EuroVelo and the
  other international routes in red, national in blue, regional and local paler — from
  [Waymarked Trails](https://cycling.waymarkedtrails.org/), which renders OpenStreetMap's
  route relations as transparent tiles. It sits under the day colours at half strength, so
  it reads as context rather than competing with the ride, and it is **off until asked for**:
  no tile is fetched from a third party while the button is untouched.
- A **menu** beside the share button holds the things that are about the trip rather than
  about one of its days. Its first entry is the **download centre**: the tracks as GPX and
  the photos as a zip, for the whole trip or for a single day, each day listed with what it
  actually has on it so nobody taps a day that holds nothing. Each day is its own `<trk>` in
  the GPX and a leg taken by train, ferry or bus is a track of its own, so no mapping tool
  totals up kilometres nobody rode. Both kinds of line come **as they arrived**, not as the
  page draws them: what the database holds is reduced to a drawing budget, so every ride
  whose recording the budget cut into is kept whole in a private `tracks` bucket, and the
  **planned route** — offered as its own file — comes from the copy `/route` cuts from. A
  FIT file recorded at a point a second is the case that matters: nothing on the internet
  has a copy of it, so what is not kept at import is gone. Days imported before this existed
  come as the map draws them until `/refreshtracks` (or the nightly job) fetches them back
  from Komoot — which it can only do for days that came from Komoot in the first place. A
  day uploaded as a GPX or FIT file was never stored anywhere and cannot be recovered; the
  command counts those and says so instead of pretending otherwise. The pictures come as they are stored — the untouched
  file for anything sent as a document, a 2048 px copy for the rest, a Live Photo's motion
  beside its still — and the page says so, because the camera original never reached the bot
  in the first place. Nothing is packed until a link is tapped, and nothing is cached: a
  zip is built for that one request and handed straight to the browser. A trip too large to
  pack in one go says so and points at the day-by-day files, which always work.

## Setup

1. **Supabase**: create a project, run [supabase/schema.sql](supabase/schema.sql) in the SQL
   editor (creates the tables, the public `photos` and `archives` buckets and the private
   `plans` and `tracks` ones).
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
| `/livephoto` | place a Live Photo's video by hand: pick the day, then the photo |
| `/replace` | swap the picture behind a photo, keeping its caption, map pin and place in the day |
| `/clearday` | pick a day and empty it: every note, photo and track on it |
| `/live` | what the live banner is showing, and why; `/live off` takes it down |
| `/mypage`, `/newmypage` | permanent page with all trips; new link |
| `/archive` | download the trip as a self-contained bundle |
| `/route`, `/route 150` | cut the next 130 km (or 150) of plan from where you are and send it as a GPX |
| `/supermarkt`, `/supermarkt 25` | shops on the next 50 km (or 25) of route, nearest first |
| `/refreshplan` | re-sync planned Komoot routes |
| `/refreshtracks` | keep older Komoot days as they were recorded, for the download centre |
| `/refreshphotos` | pin photos that arrived before their day's track |
| `/refreshweather` | fill in weather and wind for older days, from the historical archive — including days with no route, from where their photos were taken |
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
day's track, its place in the day's order, who took it and the motion behind it if it was a
Live Photo all stay as they were — only the
file changes. That matters when the whole trip's photos come back from an edit: deleting and
re-sending them would strip every caption and drop each one at the end of the day it used to
sit in the middle of. After a swap the day's photo list comes straight back, so working
through a trip is one tap per picture. The new files are written under fresh names rather
than over the old ones, because the page, Telegram's previews and any CDN in between cache by
URL; the old files are removed once the row no longer points at them. A pick expires after an
hour, so a forgotten `/replace` cannot swallow the next photo sent into the chat.

`/livephoto` is that browser once more, for the videos the bot could not place. Two windows
run here rather than one: a video is only paired with the next photo to arrive for five
minutes, because that guess is about how recently the two were sent, but it is *kept* for a
week, because that is about how long someone has to come back and place it by hand. The
buttons carry the video's identity as the first eight characters of its id — a photo's own id
already costs 36 of Telegram's 64 bytes, and both have to travel in one payload.

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
inlined script, photos are local files — a Live Photo's motion travels beside its still
and plays on hover there too — and each day is written out as GPX.
Drop the folder on any static host — including your own server — and it works.

That is the traveller's copy of the whole trip, made from Telegram. The family's is the
**download centre** in the page's own menu, which needs no bot and no command: single days,
single kinds of file, built on request.
