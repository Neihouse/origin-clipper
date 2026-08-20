CREATE TYPE "public"."blob_cleanup_status" AS ENUM('retained', 'processing', 'deleted', 'failed');--> statement-breakpoint
CREATE TYPE "public"."instagram_collaboration_status" AS ENUM('not_requested', 'pending', 'accepted');--> statement-breakpoint
CREATE TYPE "public"."publication_attempt_status" AS ENUM('scheduled', 'processing', 'completed', 'failed', 'cancelled', 'manual_review');--> statement-breakpoint
CREATE TYPE "public"."publication_trigger" AS ENUM('immediate', 'scheduled');--> statement-breakpoint
ALTER TYPE "public"."platform_publish_status" ADD VALUE 'manual_review';--> statement-breakpoint
CREATE TABLE "clip_publications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clip_id" uuid NOT NULL,
	"video_asset_url" text,
	"video_asset_etag" text,
	"video_asset_fetched_at" timestamp with time zone,
	"video_asset_error" text,
	"blob_cleanup_status" "blob_cleanup_status" DEFAULT 'retained' NOT NULL,
	"blob_cleanup_claim_token" text,
	"blob_cleanup_locked_until" timestamp with time zone,
	"blob_cleanup_attempted_at" timestamp with time zone,
	"blob_deleted_at" timestamp with time zone,
	"blob_cleanup_error" text,
	"instagram_publish_status" "platform_publish_status" DEFAULT 'not_started' NOT NULL,
	"instagram_container_id" text,
	"instagram_media_id" text,
	"instagram_permalink" text,
	"instagram_published_at" timestamp with time zone,
	"instagram_publish_error" text,
	"facebook_publish_status" "platform_publish_status" DEFAULT 'not_started' NOT NULL,
	"facebook_post_id" text,
	"facebook_permalink" text,
	"facebook_published_at" timestamp with time zone,
	"facebook_publish_error" text,
	"instagram_collaboration_status" "instagram_collaboration_status" DEFAULT 'not_requested' NOT NULL,
	"instagram_collaboration_updated_at" timestamp with time zone,
	"publish_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clip_publications_id_clip_id_unique" UNIQUE("id","clip_id"),
	CONSTRAINT "clip_publications_cleanup_claim_check" CHECK (("clip_publications"."blob_cleanup_status" = 'processing' AND "clip_publications"."blob_cleanup_claim_token" IS NOT NULL AND "clip_publications"."blob_cleanup_locked_until" IS NOT NULL) OR ("clip_publications"."blob_cleanup_status" <> 'processing' AND "clip_publications"."blob_cleanup_claim_token" IS NULL AND "clip_publications"."blob_cleanup_locked_until" IS NULL)),
	CONSTRAINT "clip_publications_deleted_asset_check" CHECK ("clip_publications"."blob_cleanup_status" <> 'deleted' OR ("clip_publications"."blob_deleted_at" IS NOT NULL AND "clip_publications"."video_asset_url" IS NULL AND "clip_publications"."video_asset_etag" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "publication_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clip_id" uuid NOT NULL,
	"publication_id" uuid NOT NULL,
	"trigger" "publication_trigger" NOT NULL,
	"status" "publication_attempt_status" NOT NULL,
	"scheduled_for" timestamp with time zone,
	"authorized_at" timestamp with time zone NOT NULL,
	"authorized_caption" text NOT NULL,
	"authorized_instagram_user_id" text NOT NULL,
	"authorized_facebook_page_id" text NOT NULL,
	"error" text,
	"claim_token" text,
	"claimed_at" timestamp with time zone,
	"locked_until" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publication_attempts_scheduled_time_check" CHECK (("publication_attempts"."trigger" = 'scheduled') = ("publication_attempts"."scheduled_for" IS NOT NULL)),
	CONSTRAINT "publication_attempts_processing_claim_check" CHECK ("publication_attempts"."status" <> 'processing' OR ("publication_attempts"."claim_token" IS NOT NULL AND "publication_attempts"."claimed_at" IS NOT NULL AND "publication_attempts"."locked_until" IS NOT NULL AND "publication_attempts"."completed_at" IS NULL)),
	CONSTRAINT "publication_attempts_processing_lease_check" CHECK (("publication_attempts"."status" = 'processing') = ("publication_attempts"."locked_until" IS NOT NULL)),
	CONSTRAINT "publication_attempts_scheduled_lifecycle_check" CHECK ("publication_attempts"."status" <> 'scheduled' OR ("publication_attempts"."claim_token" IS NULL AND "publication_attempts"."claimed_at" IS NULL AND "publication_attempts"."locked_until" IS NULL AND "publication_attempts"."completed_at" IS NULL)),
	CONSTRAINT "publication_attempts_terminal_timestamp_check" CHECK ("publication_attempts"."status" NOT IN ('completed', 'failed', 'cancelled', 'manual_review') OR "publication_attempts"."completed_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "clip_publications" ADD CONSTRAINT "clip_publications_clip_id_clips_id_fk" FOREIGN KEY ("clip_id") REFERENCES "public"."clips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_attempts" ADD CONSTRAINT "publication_attempts_clip_id_clips_id_fk" FOREIGN KEY ("clip_id") REFERENCES "public"."clips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_attempts" ADD CONSTRAINT "publication_attempts_publication_clip_fk" FOREIGN KEY ("publication_id","clip_id") REFERENCES "public"."clip_publications"("id","clip_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clip_publications_clip_id_unique" ON "clip_publications" USING btree ("clip_id");--> statement-breakpoint
CREATE INDEX "clip_publications_cleanup_due_idx" ON "clip_publications" USING btree ("blob_cleanup_status","publish_verified_at");--> statement-breakpoint
CREATE INDEX "publication_attempts_due_idx" ON "publication_attempts" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE INDEX "publication_attempts_clip_history_idx" ON "publication_attempts" USING btree ("clip_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "publication_attempts_one_active_clip_idx" ON "publication_attempts" USING btree ("clip_id") WHERE "publication_attempts"."status" in ('scheduled', 'processing', 'manual_review');--> statement-breakpoint
-- Preserve every non-default durable legacy 0001 asset/platform result while
-- new code moves to clip_publications. Legacy assets have no trustworthy ETag,
-- so video_asset_etag remains NULL and automatic cleanup will not claim them.
-- Authorization attempts cannot be reconstructed safely because 0001 did not
-- snapshot target ids; publication_attempts history begins with the first
-- explicit Publish now / Schedule Publish action after 0002.
INSERT INTO "clip_publications" (
	"clip_id",
	"video_asset_url",
	"video_asset_fetched_at",
	"video_asset_error",
	"instagram_publish_status",
	"instagram_container_id",
	"instagram_media_id",
	"instagram_permalink",
	"instagram_published_at",
	"instagram_publish_error",
	"facebook_publish_status",
	"facebook_post_id",
	"facebook_permalink",
	"facebook_published_at",
	"facebook_publish_error",
	"created_at",
	"updated_at"
)
SELECT
	"id",
	"video_asset_url",
	"video_asset_fetched_at",
	"video_asset_error",
	"instagram_publish_status",
	"instagram_container_id",
	"instagram_media_id",
	"instagram_permalink",
	"instagram_published_at",
	"instagram_publish_error",
	"facebook_publish_status",
	"facebook_post_id",
	"facebook_permalink",
	"facebook_published_at",
	"facebook_publish_error",
	"created_at",
	"updated_at"
FROM "clips"
WHERE
	"video_asset_url" IS NOT NULL
	OR "video_asset_fetched_at" IS NOT NULL
	OR "video_asset_error" IS NOT NULL
	OR "instagram_publish_status" <> 'not_started'
	OR "instagram_container_id" IS NOT NULL
	OR "instagram_media_id" IS NOT NULL
	OR "instagram_permalink" IS NOT NULL
	OR "instagram_published_at" IS NOT NULL
	OR "instagram_publish_error" IS NOT NULL
	OR "facebook_publish_status" <> 'not_started'
	OR "facebook_post_id" IS NOT NULL
	OR "facebook_permalink" IS NOT NULL
	OR "facebook_published_at" IS NOT NULL
	OR "facebook_publish_error" IS NOT NULL
ON CONFLICT ("clip_id") DO NOTHING;
