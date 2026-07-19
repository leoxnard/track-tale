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
};
