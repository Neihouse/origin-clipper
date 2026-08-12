CREATE TYPE "public"."clip_status" AS ENUM('discovered', 'shortlisted', 'approved', 'rejected', 'published');--> statement-breakpoint
CREATE TABLE "clips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"twitch_clip_id" text NOT NULL,
	"broadcaster_id" text NOT NULL,
	"title" text NOT NULL,
	"creator_name" text NOT NULL,
	"url" text NOT NULL,
	"embed_url" text NOT NULL,
	"thumbnail_url" text NOT NULL,
	"view_count" integer DEFAULT 0 NOT NULL,
	"duration_seconds" real NOT NULL,
	"clip_created_at" timestamp with time zone NOT NULL,
	"stream_date" text NOT NULL,
	"video_id" text,
	"vod_offset_seconds" integer,
	"ranking_score" real,
	"ranking_reason" text,
	"status" "clip_status" DEFAULT 'discovered' NOT NULL,
	"proposed_caption" text,
	"proposed_title" text,
	"notes" text,
	"approved_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "clips_twitch_clip_id_idx" ON "clips" USING btree ("twitch_clip_id");