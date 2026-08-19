import { telegramChannel } from "eve/channels/telegram";

/**
 * Telegram front door.
 *
 * Requires two environment variables to actually deliver anything:
 *   TELEGRAM_BOT_TOKEN           — from BotFather
 *   TELEGRAM_WEBHOOK_SECRET_TOKEN — must match the secret_token registered
 *                                   with setWebhook
 *
 * Both are read lazily, so the deployment stays healthy while they are
 * unset; inbound requests simply fail verification with 401. eve does not
 * call setWebhook itself — register the deployed URL manually against
 * POST <deployment>/eve/v1/telegram.
 */
export default telegramChannel({
  // Only used to recognize @mentions in groups; direct messages work
  // without it.
  botUsername: process.env.TELEGRAM_BOT_USERNAME,

  // Charts and screenshots are the natural way to discuss a market, so
  // accept images and PDFs inbound. The configured model must be
  // vision-capable for these to be worth anything.
  uploadPolicy: {
    allowedMediaTypes: ["image/*", "application/pdf"],
    maxBytes: 10 * 1024 * 1024,
  },
});
