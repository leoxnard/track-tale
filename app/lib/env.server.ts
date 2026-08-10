function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

/** Reads a feature switch. Anything but a plain yes counts as off. */
function isOn(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

export const env = {
  get supabaseUrl() {
    return required("SUPABASE_URL");
  },
  get supabaseServiceKey() {
    return required("SUPABASE_SERVICE_KEY");
  },
  get telegramBotToken() {
    return required("TELEGRAM_BOT_TOKEN");
  },
  get telegramWebhookSecret() {
    return required("TELEGRAM_WEBHOOK_SECRET");
  },
  get cronSecret() {
    return required("CRON_SECRET");
  },
  /** Telegram user id that is auto-registered as owner on first /start. */
  get ownerTelegramId() {
    return Number(required("TELEGRAM_OWNER_ID"));
  },
  get appOrigin() {
    return process.env.APP_ORIGIN ?? "http://localhost:5173";
  },
  /**
   * Live tracking, off unless `LIVE_TRACKING` is switched on.
   *
   * Off it stays a feature rather than a scar: the code, the schema columns and
   * the translations all remain, and every way of turning the banner on is shut
   * at its entrance — the family's page never asks Garmin, the bot says the
   * feature is off rather than promising a banner nobody will see, and inbound
   * mail 404s. Flip it back on and it all works again, no migration involved.
   *
   * The reason it is off: the trip page fetched Garmin's page on *every* render
   * while a link was live, and that request sits between a visitor and their
   * map.
   */
  get liveTracking() {
    return isOn(process.env.LIVE_TRACKING);
  },
  /**
   * Inbound mail. Both are optional: without them /api/inbound-email refuses
   * every request and live links are set by pasting into Telegram, as before.
   */
  get resendApiKey() {
    return process.env.RESEND_API_KEY || null;
  },
  /** The `whsec_…` signing secret from the Resend webhook page. */
  get resendInboundSecret() {
    return process.env.RESEND_INBOUND_SECRET || null;
  },
  /**
   * Optional. Puts a real map behind the route on the share card; without it
   * the card still renders, just on plain paper.
   */
  get maptilerKey() {
    // `||`, not `??`: an env var present but blank is how "unset" usually looks
    // in a .env file, and `?? ` would hand a blank style straight into the URL.
    return process.env.MAPTILER_KEY || null;
  },
  get maptilerStyle() {
    return process.env.MAPTILER_STYLE || "outdoor-v2";
  },
};
