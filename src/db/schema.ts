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

    // Record bookkeeping
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("clips_twitch_clip_id_idx").on(table.twitchClipId)],
);

export type Clip = typeof clips.$inferSelect;
export type NewClip = typeof clips.$inferInsert;
export type ClipStatus = (typeof clipStatusEnum.enumValues)[number];
