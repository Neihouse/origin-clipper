import {
  check,
  pgTable,
  uuid,
  text,
  integer,
  real,
  timestamp,
  pgEnum,
  foreignKey,
  index,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

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
  "manual_review",
]);

export const publicationAttemptStatusEnum = pgEnum("publication_attempt_status", [
  "scheduled",
  "processing",
  "completed",
  "failed",
  "cancelled",
  "manual_review",
]);

export const publicationTriggerEnum = pgEnum("publication_trigger", ["immediate", "scheduled"]);

export const blobCleanupStatusEnum = pgEnum("blob_cleanup_status", [
  "retained",
  "processing",
  "deleted",
  "failed",
]);

export const instagramCollaborationStatusEnum = pgEnum(
  "instagram_collaboration_status",
  ["not_requested", "pending", "accepted"],
);

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

    // Legacy 0001 publishing state retained for rollback compatibility.
    // New code reads/writes clip_publications and publication_attempts only.
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

/** Durable per-clip delivery state shared across every authorization attempt. */
export const clipPublications = pgTable(
  "clip_publications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clipId: uuid("clip_id")
      .notNull()
      .references(() => clips.id, { onDelete: "cascade" }),

    videoAssetUrl: text("video_asset_url"),
    videoAssetEtag: text("video_asset_etag"),
    videoAssetFetchedAt: timestamp("video_asset_fetched_at", { withTimezone: true }),
    videoAssetError: text("video_asset_error"),
    blobCleanupStatus: blobCleanupStatusEnum("blob_cleanup_status")
      .notNull()
      .default("retained"),
    blobCleanupClaimToken: text("blob_cleanup_claim_token"),
    blobCleanupLockedUntil: timestamp("blob_cleanup_locked_until", { withTimezone: true }),
    blobCleanupAttemptedAt: timestamp("blob_cleanup_attempted_at", { withTimezone: true }),
    blobDeletedAt: timestamp("blob_deleted_at", { withTimezone: true }),
    blobCleanupError: text("blob_cleanup_error"),

    instagramPublishStatus: platformPublishStatusEnum("instagram_publish_status")
      .notNull()
      .default("not_started"),
    instagramContainerId: text("instagram_container_id"),
    instagramMediaId: text("instagram_media_id"),
    instagramPermalink: text("instagram_permalink"),
    instagramPublishedAt: timestamp("instagram_published_at", { withTimezone: true }),
    instagramPublishError: text("instagram_publish_error"),

    facebookPublishStatus: platformPublishStatusEnum("facebook_publish_status")
      .notNull()
      .default("not_started"),
    facebookPostId: text("facebook_post_id"),
    facebookPermalink: text("facebook_permalink"),
    facebookPublishedAt: timestamp("facebook_published_at", { withTimezone: true }),
    facebookPublishError: text("facebook_publish_error"),

    instagramCollaborationStatus: instagramCollaborationStatusEnum(
      "instagram_collaboration_status",
    )
      .notNull()
      .default("not_requested"),
    instagramCollaborationUpdatedAt: timestamp("instagram_collaboration_updated_at", {
      withTimezone: true,
    }),
    publishVerifiedAt: timestamp("publish_verified_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("clip_publications_clip_id_unique").on(table.clipId),
    unique("clip_publications_id_clip_id_unique").on(table.id, table.clipId),
    index("clip_publications_cleanup_due_idx").on(
      table.blobCleanupStatus,
      table.publishVerifiedAt,
    ),
    check(
      "clip_publications_cleanup_claim_check",
      sql`(${table.blobCleanupStatus} = 'processing' AND ${table.blobCleanupClaimToken} IS NOT NULL AND ${table.blobCleanupLockedUntil} IS NOT NULL) OR (${table.blobCleanupStatus} <> 'processing' AND ${table.blobCleanupClaimToken} IS NULL AND ${table.blobCleanupLockedUntil} IS NULL)`,
    ),
    check(
      "clip_publications_deleted_asset_check",
      sql`${table.blobCleanupStatus} <> 'deleted' OR (${table.blobDeletedAt} IS NOT NULL AND ${table.videoAssetUrl} IS NULL AND ${table.videoAssetEtag} IS NULL)`,
    ),
  ],
);

/**
 * One durable audit row per explicit Publish now / Schedule Publish
 * authorization. Lifecycle fields advance on this row, but a retry or
 * reschedule always creates another row instead of rewriting the old one.
 */
export const publicationAttempts = pgTable(
  "publication_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clipId: uuid("clip_id")
      .notNull()
      .references(() => clips.id, { onDelete: "cascade" }),
    publicationId: uuid("publication_id").notNull(),
    trigger: publicationTriggerEnum("trigger").notNull(),
    status: publicationAttemptStatusEnum("status").notNull(),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    authorizedAt: timestamp("authorized_at", { withTimezone: true }).notNull(),
    authorizedCaption: text("authorized_caption").notNull(),
    authorizedInstagramUserId: text("authorized_instagram_user_id").notNull(),
    authorizedFacebookPageId: text("authorized_facebook_page_id").notNull(),
    error: text("error"),
    claimToken: text("claim_token"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("publication_attempts_due_idx").on(table.status, table.scheduledFor),
    index("publication_attempts_clip_history_idx").on(table.clipId, table.createdAt),
    foreignKey({
      columns: [table.publicationId, table.clipId],
      foreignColumns: [clipPublications.id, clipPublications.clipId],
      name: "publication_attempts_publication_clip_fk",
    }).onDelete("cascade"),
    uniqueIndex("publication_attempts_one_active_clip_idx")
      .on(table.clipId)
      .where(sql`${table.status} in ('scheduled', 'processing', 'manual_review')`),
    check(
      "publication_attempts_scheduled_time_check",
      sql`(${table.trigger} = 'scheduled') = (${table.scheduledFor} IS NOT NULL)`,
    ),
    check(
      "publication_attempts_processing_claim_check",
      sql`${table.status} <> 'processing' OR (${table.claimToken} IS NOT NULL AND ${table.claimedAt} IS NOT NULL AND ${table.lockedUntil} IS NOT NULL AND ${table.completedAt} IS NULL)`,
    ),
    check(
      "publication_attempts_processing_lease_check",
      sql`(${table.status} = 'processing') = (${table.lockedUntil} IS NOT NULL)`,
    ),
    check(
      "publication_attempts_scheduled_lifecycle_check",
      sql`${table.status} <> 'scheduled' OR (${table.claimToken} IS NULL AND ${table.claimedAt} IS NULL AND ${table.lockedUntil} IS NULL AND ${table.completedAt} IS NULL)`,
    ),
    check(
      "publication_attempts_terminal_timestamp_check",
      sql`${table.status} NOT IN ('completed', 'failed', 'cancelled', 'manual_review') OR ${table.completedAt} IS NOT NULL`,
    ),
  ],
);

export type Clip = typeof clips.$inferSelect;
export type NewClip = typeof clips.$inferInsert;
export type ClipStatus = (typeof clipStatusEnum.enumValues)[number];
export type PlatformPublishStatus = (typeof platformPublishStatusEnum.enumValues)[number];
export type PublicationAttemptStatus = (typeof publicationAttemptStatusEnum.enumValues)[number];
export type PublicationTrigger = (typeof publicationTriggerEnum.enumValues)[number];
export type BlobCleanupStatus = (typeof blobCleanupStatusEnum.enumValues)[number];
export type ScheduleStatus = PublicationAttemptStatus | "not_scheduled";
export type InstagramCollaborationStatus =
  (typeof instagramCollaborationStatusEnum.enumValues)[number];
export type ClipPublication = typeof clipPublications.$inferSelect;
export type NewClipPublication = typeof clipPublications.$inferInsert;
export type PublicationAttempt = typeof publicationAttempts.$inferSelect;
export type NewPublicationAttempt = typeof publicationAttempts.$inferInsert;
