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
  collection: {
    get windowDays() {
      return Number(process.env.COLLECTION_WINDOW_DAYS ?? 7);
    },
    get topClipLimit() {
      return Number(process.env.TOP_CLIP_LIMIT ?? 5);
    },
  },
  meta: {
    get pageId() {
      return required("META_PAGE_ID");
    },
    get igUserId() {
      return required("META_IG_USER_ID");
    },
    get pageAccessToken() {
      return required("META_PAGE_ACCESS_TOKEN");
    },
    get graphApiVersion() {
      return process.env.META_GRAPH_API_VERSION || "v21.0";
    },
  },
  blob: {
    get readWriteToken() {
      return required("BLOB_READ_WRITE_TOKEN");
    },
    get retentionDays() {
      const value = Number(process.env.VIDEO_ASSET_RETENTION_DAYS ?? 7);
      if (!Number.isInteger(value) || value < 1 || value > 30) {
        throw new Error("VIDEO_ASSET_RETENTION_DAYS must be an integer from 1 to 30");
      }
      return value;
    },
  },
  insights: {
    get refreshWindowDays() {
      return Number(process.env.INSIGHTS_REFRESH_WINDOW_DAYS ?? 14);
    },
    get batchSize() {
      return Number(process.env.INSIGHTS_BATCH_SIZE ?? 20);
    },
  },
};
