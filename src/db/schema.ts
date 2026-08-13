import {
  pgTable,
  uuid,
  text,
  integer,
  real,
  timestamp,
  pgEnum,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const clipStatusEnum = pgEnum("clip_status", [
  "discovered",
  "shortlisted",
  "approved",
  "rejected",
  "published",
]);

// Per-platform publish outcome. `clips.status` flips to "published" only once
// both instagramPublishStatus and facebookPublishStatus reach "published" —
// a partial failure leaves `status: "approved"` so the clip stays actionable
// and the Publish button stays enabled for retry.
export const platformPublishStatusEnum = pgEnum("platform_publish_status", [
  "not_started",
  "pending",
  "published",
  "failed",
]);

export const clips = pgTable(
  "clips",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // Twitch source data
    twitchClipId: text("twitch_clip_id").notNull(),
    broadcasterId: text("broadcaster_id").notNull(),
    title: text("title").notNull(),
    creatorName: text("creator_name").notNull(),
    url: text("url").notNull(),
    embedUrl: text("embed_url").notNull(),
    thumbnailUrl: text("thumbnail_url").notNull(),
    viewCount: integer("view_count").notNull().default(0),
    durationSeconds: real("duration_seconds").notNull(),
    clipCreatedAt: timestamp("clip_created_at", { withTimezone: true }).notNull(),
    // Date (YYYY-MM-DD, UTC) of the weekly collection window this clip belongs to.
    streamDate: text("stream_date").notNull(),
    // Source VOD + offset, kept so re-ranking can avoid shortlisting clips of the same moment.
    videoId: text("video_id"),
    vodOffsetSeconds: integer("vod_offset_seconds"),

    // Ranking + review state
    rankingScore: real("ranking_score"),
    rankingReason: text("ranking_reason"),
    status: clipStatusEnum("status").notNull().default("discovered"),
    proposedCaption: text("proposed_caption"),
    proposedTitle: text("proposed_title"),
    notes: text("notes"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),

    // Re-hosted video asset (Vercel Blob). Fetched once via the unofficial
    // Twitch clip-video path and reused across retries so a failed Meta call
    // never re-triggers that risky step.
    videoAssetUrl: text("video_asset_url"),
    videoAssetFetchedAt: timestamp("video_asset_fetched_at", { withTimezone: true }),
    videoAssetError: text("video_asset_error"),

    // Instagram Reels publish state
    instagramPublishStatus: platformPublishStatusEnum("instagram_publish_status")
      .notNull()
      .default("not_started"),
    instagramContainerId: text("instagram_container_id"),
    instagramMediaId: text("instagram_media_id"),
    instagramPermalink: text("instagram_permalink"),
    instagramPublishedAt: timestamp("instagram_published_at", { withTimezone: true }),
    instagramPublishError: text("instagram_publish_error"),

    // Facebook Page publish state
    facebookPublishStatus: platformPublishStatusEnum("facebook_publish_status")
      .notNull()
      .default("not_started"),
    facebookPostId: text("facebook_post_id"),
    facebookPermalink: text("facebook_permalink"),
    facebookPublishedAt: timestamp("facebook_published_at", { withTimezone: true }),
    facebookPublishError: text("facebook_publish_error"),

    // Bookkeeping for the last Publish click
    publishAttemptedAt: timestamp("publish_attempted_at", { withTimezone: true }),

    // Record bookkeeping
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("clips_twitch_clip_id_idx").on(table.twitchClipId)],
);

export type Clip = typeof clips.$inferSelect;
export type NewClip = typeof clips.$inferInsert;
export type ClipStatus = (typeof clipStatusEnum.enumValues)[number];
export type PlatformPublishStatus = (typeof platformPublishStatusEnum.enumValues)[number];
