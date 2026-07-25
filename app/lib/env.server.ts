function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
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
   * Optional. Without it the share card still renders, just on plain paper
   * instead of over a map.
   */
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
  get maptilerKey() {
    // `||`, not `??`: an env var present but blank is how "unset" usually looks
    // in a .env file, and `?? ` would hand a blank style straight into the URL.
    return process.env.MAPTILER_KEY || null;
  },
  get maptilerStyle() {
    return process.env.MAPTILER_STYLE || "outdoor-v2";
  },
};
