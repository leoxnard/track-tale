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
```

`/preview` renders the family page with fixture data (dev only, no database needed).

## Notes

- Komoot ingestion uses Komoot's internal API via the share token. It is unofficial and can
  break at any time — GPX upload is the always-works fallback, by design.
- The bot only answers Telegram users on the allowlist (owner id from env, friends via
  `/invite` codes).
