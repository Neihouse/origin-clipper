CREATE TYPE "public"."platform_publish_status" AS ENUM('not_started', 'pending', 'published', 'failed');--> statement-breakpoint
ALTER TABLE "clips" ADD COLUMN "video_asset_url" text;--> statement-breakpoint
ALTER TABLE "clips" ADD COLUMN "video_asset_fetched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clips" ADD COLUMN "video_asset_error" text;--> statement-breakpoint
ALTER TABLE "clips" ADD COLUMN "instagram_publish_status" "platform_publish_status" DEFAULT 'not_started' NOT NULL;--> statement-breakpoint
ALTER TABLE "clips" ADD COLUMN "instagram_container_id" text;--> statement-breakpoint
ALTER TABLE "clips" ADD COLUMN "instagram_media_id" text;--> statement-breakpoint
ALTER TABLE "clips" ADD COLUMN "instagram_permalink" text;--> statement-breakpoint
ALTER TABLE "clips" ADD COLUMN "instagram_published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clips" ADD COLUMN "instagram_publish_error" text;--> statement-breakpoint
ALTER TABLE "clips" ADD COLUMN "facebook_publish_status" "platform_publish_status" DEFAULT 'not_started' NOT NULL;--> statement-breakpoint
ALTER TABLE "clips" ADD COLUMN "facebook_post_id" text;--> statement-breakpoint
ALTER TABLE "clips" ADD COLUMN "facebook_permalink" text;--> statement-breakpoint
ALTER TABLE "clips" ADD COLUMN "facebook_published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clips" ADD COLUMN "facebook_publish_error" text;--> statement-breakpoint
ALTER TABLE "clips" ADD COLUMN "publish_attempted_at" timestamp with time zone;