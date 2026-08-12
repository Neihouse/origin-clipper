function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Central, lazy accessor for environment configuration. Values are read via
 * getters (not resolved eagerly) so importing this module never throws —
 * Next.js evaluates route modules during `next build`, before real env vars
 * are necessarily available.
 */
export const config = {
  twitch: {
    get clientId() {
      return required("TWITCH_CLIENT_ID");
    },
    get clientSecret() {
      return required("TWITCH_CLIENT_SECRET");
    },
    get broadcasterLogin() {
      return required("TWITCH_BROADCASTER_LOGIN");
    },
    get broadcasterId() {
      return required("TWITCH_BROADCASTER_ID");
    },
  },
  cron: {
    get secret() {
      return required("CRON_SECRET");
    },
  },
  admin: {
    get passwordHash() {
      return required("ADMIN_PASSWORD_HASH");
    },
    get sessionSecret() {
      return required("SESSION_SECRET");
    },
  },
  den: {
    get bookingUrl() {
      return process.env.DEN_BOOKING_URL || "https://den.primordialgroove.com/book/dj";
    },
  },
  collection: {
    get windowDays() {
      return Number(process.env.COLLECTION_WINDOW_DAYS ?? 7);
    },
    get topClipLimit() {
      return Number(process.env.TOP_CLIP_LIMIT ?? 5);
    },
  },
};
