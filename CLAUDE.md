# CLAUDE.md

Guidance for AI assistants working in this repository.

## What this is

TrackTale is a private, invite-only trip journal. Travellers feed it through a **Telegram
bot** (tracks, photos, notes); family follows on a **secret no-login link** — a map with
day-coloured routes, photos, notes, stats and weather. There are no user accounts on the
web side: knowing the slug *is* the authorisation.

Read [README.md](README.md) first — it documents every bot command and every product
behaviour in detail, and it is kept current. This file covers how the code is arranged.

## Stack

React Router v8 in **Framework mode** (SSR) + React 19 + Tailwind v4, TypeScript strict,
Vite 8, Vitest 4. Data in **Supabase** (Postgres + Storage, service-role key, no RLS
reliance). Bot on **grammy**. Maps with **maplibre-gl** client-side, hand-rolled SVG
server-side. Deployed to **Vercel** (a `Dockerfile` exists as an alternative target).

`.agents/skills/react-router/` holds the React Router reference — consult
`references/framework-mode.md` before touching routing, loaders or actions.

## Commands

```sh
npm run dev        # http://localhost:5173
npm run typecheck  # react-router typegen && tsc — run after touching routes or types
npm test           # vitest run
npm run build      # production build
```

CI (`.github/workflows/ci.yml`) runs `npm audit --audit-level=high`, typecheck, tests and
build on every push to main and every PR. **All four must pass.**

`/preview` renders the family page from `app/fixtures/preview-trip.json` — dev only, no
database, no env vars. Use it to check viewer changes without a Supabase project.

## Layout

```
app/routes.ts               route table (explicit, not file-system based)
app/routes/
  home.tsx                  landing page
  t.$slug.tsx               the family page — the big one (~1.3k lines)
  t.$slug.downloads.tsx     the download centre, first entry in the page's menu
  t.$slug.download.$file.ts the files it links to — GPX and photo zips, built per request
  traveler.$slug.tsx        a traveller's permanent page across all trips
  preview.tsx               fixture-driven family page, dev only
  lang.ts                   language cookie switch
  api.telegram.ts           Telegram webhook (secret-token guarded)
  api.cron.ts               daily maintenance (Bearer CRON_SECRET, 01:00 UTC)
  api.inbound-email.ts      Resend inbound → Garmin LiveTrack link
app/components/             viewer UI (charts, lightbox, share, language, vehicle art)
app/lib/                    everything else
app/fixtures/               preview trip + a captured LiveTrack page for tests
supabase/schema.sql         the whole schema; run it in the SQL editor
scripts/                    rail-GPX builder + checked-in leg definitions
```

### `.server.ts` is load-bearing

The suffix keeps a module out of the client bundle. Anything touching Supabase, env vars,
grammy, `sharp` or `@resvg/resvg-js` **must** be `*.server.ts`. Pure logic stays unsuffixed
so it can be imported by both the viewer and the tests.

That split is also the testing strategy: `x.ts` is pure and has `x.test.ts`; `x.server.ts`
does I/O and generally does not.

### The bot, by responsibility

`bot.server.ts` (~1.4k lines) is the command router and wiring. Handlers live beside it:

| Module | Owns |
|---|---|
| `bot-access.server.ts` | allowlist, invites, `requireTrip`/`requireDay`/`requireTripManager` |
| `bot-ingest.server.ts` | Komoot / GPX / FIT → `track_segments`, plan refresh |
| `day-weather.server.ts` | filling `weather_cache` for a day — from its route, or from its photos when it has none |
| `bot-photos.server.ts` | photo + document upload, EXIF, compression, twin detection |
| `bot-motion.server.ts` | the video half of a Live Photo: matching it to its still by sight, or parking it until one arrives |
| `bot-actions.server.ts` | trip lifecycle: create, switch, rename, dates, end, delete |
| `bot-route.server.ts` | `/route` — where the traveller was last seen, and the cut GPX that goes back |
| `shops.server.ts` | `/supermarkt` — the Overpass request for shops along the road ahead, and its message |
| `plan-source.server.ts` | keeping each planned route as imported, at full resolution, for `/route` to cut from |
| `bot-chrome.server.ts` | plumbing only — send/edit a view, record what a message made, download a file, keep the webhook subscribed |
| `screens.server.ts` | the tappable screens (trip status, day picker, confirmations) |
| `manage.ts` / `manage.server.ts` | the `/manage`, `/replace` and Live-Photo pickers; `manage.ts` is pure because callback payloads have a hard 64-byte limit |
| `entities.server.ts` | deleting one thing, shared by `/undo`, `/delete` and `/manage` |
| `media-replace.server.ts` | `/replace` — swap the file, keep the row |
| `bot-help.ts` | help text |

A `View` is `{ text, keyboard }`; screens return one, `bot-chrome` puts it on the chat.
Messages are **edited in place** rather than re-sent — that is the established pattern.

### Domain logic worth knowing before editing

- `track.ts` — the normalized `TrackPoint`/`NormalizedTrack` shape every source converges
  on, plus stats, decimation, profiles and `DAY_COLORS`.
- `transport.ts` — a leg travelled rather than ridden (train/ferry/bus). The mode lives in
  the segment's existing `sport` column, deliberately, so it needs no migration. Transit
  kilometres are drawn but **excluded** from distance, climb and the progress bar.
- `track.ts`'s `thinPlan`/`simplify` vs `decimate` — a plan is stored *thinned*, and how it
  is thinned is load-bearing: `decimate` keeps every nth point, which cuts the corner off any
  bend whose apex falls between two kept indices, and the resulting line is what `/route`
  hands to a device. Plans go through `thinPlan` (Douglas-Peucker, bounded shape error);
  rides still use `decimate`, where the stride is only ever drawn. `thinPlan` will exceed the
  point budget rather than fall back to a stride — the budget protects a page render, the
  shape is what a route file means.
- `route-cut.ts` — `/route`, the pure half: the next N kilometres of the plan, cut from
  wherever the traveller is. Read the header before changing what the target counts — the
  leg back onto the plan is deliberately *not* counted against it, and the position is
  deliberately the file's first point.
- `shops.ts` — the pure half of `/supermarkt`: sampling the road ahead into a corridor,
  building the Overpass query, and measuring every hit back against the route for the two
  numbers that decide a stop — how far along, and how far off. Reuses `buildPlanIndex` from
  `plan-anchor.ts` rather than projecting onto a line a third time. The sample spacing is the
  search radius on purpose; the header says why.
- `downloads.ts` / `downloads.server.ts` — the download centre. The pure half is the file
  names, which *are* the request (`day-3-photos.zip`), parsed straight back out of the URL.
  The server half builds a GPX (one `<trk>` per day, transit legs in tracks of their own) or
  a zip of the stored photos, in memory, per request — hence the size ceiling and the 413 it
  answers with, which points at the day files instead. Ridden tracks are the *stored* line,
  which is what the page draws; the planned route goes through `wholePlanAtSource` in
  `bot-route.server.ts` for the same reason `/route` does.
- `day-stretches.ts` — one answer to "what was pedalled, and where did it stop", shared by
  the page, the share card and the archive. Don't re-derive it a fourth time.
- `plan-anchor.ts` + `tour-layout.ts` — laying each ridden day over the stretch of the
  *plan* it covered, matched by coordinates rather than stacked in sequence. Both files
  carry long comments explaining why the obvious approach is wrong; read them first.
- `wind.ts` — the wind rose behind the family page: hourly wind from `weather.ts`, sampled at
  one site per 10 km of route (`sampleSites`, one Open-Meteo request for all of them) and
  matched to a track's timestamps by nearest site, then summed **by distance** into headwind,
  crosswind and the petals, each petal split across the Beaufort speed classes the legend
  names. Wind directions from the API are meteorological (where it blows *from*); the rose's
  own sectors are **relative to the direction of travel**, which is what keeps a loop
  readable — a ride that ends where it started has no mean heading to draw a compass rose
  around. `directness` and `relativeConcentration` guard anything that would otherwise state
  a direction for such a ride. The tests exist mostly to keep those frames from being flipped
  by accident. `WindRose.tsx` lists its deviations from the standard figure at the top.
- `wind-field.ts` — the map overlay's arrows. Stores samples **on the route** only; the lanes,
  the spacing and the drift are all derived per frame from metres-per-pixel (`channelFor`), so
  the channel is a constant ~1 cm either side at any zoom. `detailAlpha` cross-fades between
  power-of-two strides — the sets nest, so zooming adds arrows between the existing ones
  instead of swapping a whole set in at one pixel of zoom. Arrows point where the wind *went*
  (`towardDeg`), the reverse of everything in `wind.ts`. The maplibre layer that draws it lives
  in `t.$slug.tsx`, on top of the day lines, with a paper halo baked into each icon.
- `riding-weather.ts` — rain and temperature over the *riding hours*, off the same hourly
  series and sample sites as the wind rose. Rain is an hourly accumulation stamped at the end
  of its hour and must never be interpolated; temperature is an instant and must be. Both
  cope with rows cached before those fields were fetched, where the arrays are simply absent,
  and with a track whose clock runs backwards. `hours` is the ride hour by hour, which is what
  the temperature panel draws; `DayWeather.tsx` holds those panels and their chips, and
  `t.$slug.tsx` keeps the one-panel-at-a-time state for the whole page.
- `photo-sites.ts` — where to ask about the weather on a day with no route: the places its
  photos were taken, one per weather grid cell. Deliberately *not* `sampleSites` on the photo
  positions — that measures along the sequence and would answer for ground between two shots
  that nobody stood on. `sitesCovered` is what keeps a camera roll from costing one request
  per picture. Route days are untouched; the wiring lives in `day-weather.server.ts`.
- `live-photo.ts` + `bot-motion.server.ts` — which still an incoming video is the motion of.
  Telegram carries the two halves of a Live Photo across as two unrelated updates with the
  photo's file name stripped, so it is worked out twice. First **by sight**: Telegram's cover
  frame for the video is the photograph itself, so `phash` answers it outright, for the whole
  trip, at the looser `MOTION_*` tolerance (a cover frame is a second and a half off the
  shutter, and a wrong answer costs nothing — nothing is overwritten). Failing that, **by
  order**, in the pure half: the *newest* still inside a five-minute window that hasn't got
  motion. The comment there says why newest rather than oldest; it is the difference between
  the motion landing on the Live Photo and landing on a plain shot sent four minutes earlier.
- `components/live-motion.ts` — the finger gestures behind a Live Photo, shared by the grid
  tile and the lightbox because both got the same two things wrong on their own: `pointerleave`
  fires on the way out of an ordinary tap on iOS (so it is only a stop for a mouse), and the
  click after a long press has to be swallowed or the tile's link opens on top of the video
  it just played. Read the header before touching either component.
- `photo-index.server.ts` — fingerprints for a set of stored photos, filled in lazily and
  written back. Exists so the twin finder and the motion matcher don't import each other.
- `phash.ts` / `photo-match.ts` / `photo-order.ts` — recognising an edited re-upload as the
  same shot, pinning a photo to the route by time, and ordering by capture time.
- `og.server.ts`, `basemap.server.ts`, `archive.server.ts` — server-rendered SVG for the
  share card and the self-contained zip. No browser, no tiles at render time.
- `i18n.ts` — English + German, plain objects, no dependency. Anything with a number in it
  is a function so plurals and word order stay in the translation.

## Conventions

- **Comments explain *why*, at length, when the reasoning is non-obvious.** Most modules
  open with a paragraph naming the alternative that was rejected and what it got wrong.
  Match that voice: no restating the code, no `// increments i`. Where a subtlety cost
  someone an afternoon, say so.
- Import app modules with relative paths from `routes/` (`../lib/x`); `~/*` maps to
  `./app/*` if needed.
- Strict TypeScript, `verbatimModuleSyntax` — use `import type` for types.
- Env access goes through `env.server.ts` getters (lazy, so a missing var fails at use, not
  at import). Never read `process.env` directly elsewhere.
- Feature flags are read with the same `isOn` shape: anything but a plain yes is off.
- Supabase is reached via the memoised `supabase()` client, never a fresh `createClient`.
- Tests are Vitest, colocated, `describe`/`it`, with small hand-built fixtures at the top
  of the file (see `track.test.ts`).
- Prose in user-facing strings and comments is **British English** ("kilometres",
  "traveller", "colour"); identifiers stay American (`color`, `traveler_slug`) where the
  schema already chose.

## Commit and branch conventions

- Commit subjects are **imperative, sentence case, no prefix, no scope** and describe the
  effect in plain language: "Draw no train until the chart knows how wide it is", "Stop the
  photo markers dropping into the corner on load". Not "fix: ..." or "feat(map): ...".
- Work on the branch you were assigned; PRs merge into `main`.
- Do not open a PR unless asked.

## Things that will bite you

- **A schema change means editing `supabase/schema.sql` and telling the user to run it.**
  There is no migration runner. Prefer reusing an existing column (see `transport.ts`) over
  adding one.
- **The Telegram webhook subscription lives on Telegram's side.** Button taps need
  `callback_query` in `allowed_updates`; without it `/manage` hangs on "Loading…" forever
  while ordinary messages keep working. `ensureTapsDelivered` re-registers on cold start
  and in the nightly cron; `/diag fix` forces it.
- **`api.telegram.ts` always returns 200**, even on failure, so Telegram does not retry a
  poison update. Errors are logged, not surfaced as a status.
- **Live tracking is off by default** (`LIVE_TRACKING=0`) because the page fetched Garmin on
  every render. The code, columns and translations all remain — every entrance is shut, not
  removed. Keep it that way when touching that path.
- **The stored plan is a thinned copy; the original lives in the `plans` bucket.** Anything
  that hands a file to a device rather than drawing a line on a page must go through
  `planForCut` (a cut from a position) or `wholePlanAtSource` (the whole thing), not
  `loadPlan`. Both read the kept original first, fall back to re-fetching from Komoot, then
  to the thinned line — and must survive all three being unavailable. Deleting a plan
  segment or a trip has to take the stored original with it.
- **Komoot ingestion uses an unofficial internal API.** It can break at any time; GPX upload
  is the always-works fallback, by design. Don't make Komoot a hard dependency of anything.
- **Callback payloads are capped at 64 bytes** by Telegram — that constraint is why
  `manage.ts` encodes them the way it does.
- **Serverless: don't leave promises running past the response.** Await work that must
  happen, as `api.telegram.ts` does.
- Photos are stored as a 2048 px copy plus a thumb; `/replace` writes **new** filenames
  because the page, Telegram previews and any CDN cache by URL.
- `public/legs/*.gpx` are build artefacts committed by
  `.github/workflows/rail-gpx.yml` from `scripts/legs/*.json` — edit the JSON definition,
  not the GPX.

## Environment

`.env.example` is the complete list with per-var commentary. Required: `SUPABASE_URL`,
`SUPABASE_SERVICE_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`,
`TELEGRAM_OWNER_ID`, `CRON_SECRET`, `APP_ORIGIN`. Optional: `LIVE_TRACKING`,
`RESEND_API_KEY`, `RESEND_INBOUND_SECRET`, `MAPTILER_KEY`, `MAPTILER_STYLE`, `OVERPASS_URL`.
Storage buckets: `photos` and `archives` are public; `plans` is private and holds the
untouched planned routes.
