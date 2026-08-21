CREATE TABLE "clip_publication_insights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clip_id" uuid NOT NULL,
	"instagram_insights_fetched_at" timestamp with time zone,
	"instagram_views" integer,
	"instagram_reach" integer,
	"instagram_likes" integer,
	"instagram_comments" integer,
	"instagram_shares" integer,
	"instagram_saved" integer,
	"instagram_insights_error" text,
	"facebook_insights_fetched_at" timestamp with time zone,
	"facebook_video_views" integer,
	"facebook_reactions" integer,
	"facebook_comments" integer,
	"facebook_shares" integer,
	"facebook_insights_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clip_publication_insights" ADD CONSTRAINT "clip_publication_insights_clip_id_clips_id_fk" FOREIGN KEY ("clip_id") REFERENCES "public"."clips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clip_publication_insights_clip_id_unique" ON "clip_publication_insights" USING btree ("clip_id");