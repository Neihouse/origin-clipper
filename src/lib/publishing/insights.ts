import { and, asc, eq, gte, or, sql } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { clipPublicationInsights, clipPublications } from "@/db/schema";
import { config } from "@/lib/config";
import { MetaGraphApiError } from "@/lib/meta/client";
import { getFacebookVideoInsights, getInstagramMediaInsights } from "@/lib/meta/insights";

export type PlatformInsightsOutcome = "skipped" | "refreshed" | "error";

export interface InsightsRefreshResult {
  clipId: string;
  instagram: PlatformInsightsOutcome;
  facebook: PlatformInsightsOutcome;
}

export interface InsightsRefreshSummary {
  attempted: number;
  refreshed: number;
  errored: number;
}

interface InsightsRefreshOptions {
  db?: Db;
}

// Leaves headroom under the cron route's 300s maxDuration so a slow Meta
// outage returns a partial summary instead of getting killed mid-batch —
// staleness ordering means the next tick picks up whatever's left.
const REFRESH_DEADLINE_MS = 250_000;

function safeGraphError(error: MetaGraphApiError): string {
  const subcode = error.errorSubcode ? `/${error.errorSubcode}` : "";
  return `Meta rejected the insights request (code ${error.code}${subcode}).`;
}

function safeFailure(error: unknown): string {
  if (error instanceof MetaGraphApiError) return safeGraphError(error);
  return "The insights request failed before a response was received.";
}

type InsightsPatch = Partial<typeof clipPublicationInsights.$inferInsert>;

/**
 * Refreshes one clip's Meta post-performance metrics. Only fetches a
 * platform that's actually published with a usable id; on a per-platform
 * fetch failure, only that platform's error column is written and its
 * existing metrics / fetched-at are left untouched, so a transient Meta
 * outage never wipes last-good numbers.
 */
export async function refreshInsightsForClip(
  clipId: string,
  options: InsightsRefreshOptions = {},
): Promise<InsightsRefreshResult> {
  const db = options.db ?? getDb();

  const [publication] = await db
    .select()
    .from(clipPublications)
    .where(eq(clipPublications.clipId, clipId))
    .limit(1);

  if (!publication) {
    throw new Error(`No clipPublications row for clip ${clipId}`);
  }

  const result: InsightsRefreshResult = { clipId, instagram: "skipped", facebook: "skipped" };
  const now = new Date();
  const patch: InsightsPatch = {};

  if (publication.instagramPublishStatus === "published" && publication.instagramMediaId) {
    try {
      const metrics = await getInstagramMediaInsights(publication.instagramMediaId);
      patch.instagramInsightsFetchedAt = now;
      patch.instagramViews = metrics.views;
      patch.instagramReach = metrics.reach;
      patch.instagramLikes = metrics.likes;
      patch.instagramComments = metrics.comments;
      patch.instagramShares = metrics.shares;
      patch.instagramSaved = metrics.saved;
      patch.instagramInsightsError = null;
      result.instagram = "refreshed";
    } catch (error) {
      patch.instagramInsightsError = safeFailure(error);
      result.instagram = "error";
    }
  }

  // facebookPostId is the Facebook video id returned by publishPageVideo's
  // POST /{page-id}/videos call — the same id /video_insights and the direct
  // object-fields endpoint expect, despite the column's name.
  if (publication.facebookPublishStatus === "published" && publication.facebookPostId) {
    try {
      const metrics = await getFacebookVideoInsights(publication.facebookPostId);
      patch.facebookInsightsFetchedAt = now;
      patch.facebookVideoViews = metrics.videoViews;
      patch.facebookReactions = metrics.reactions;
      patch.facebookComments = metrics.comments;
      patch.facebookShares = metrics.shares;
      patch.facebookInsightsError = null;
      result.facebook = "refreshed";
    } catch (error) {
      patch.facebookInsightsError = safeFailure(error);
      result.facebook = "error";
    }
  }

  if (Object.keys(patch).length === 0) {
    return result;
  }

  await db
    .insert(clipPublicationInsights)
    .values({ clipId, ...patch, updatedAt: now })
    .onConflictDoUpdate({
      target: clipPublicationInsights.clipId,
      set: { ...patch, updatedAt: now },
    });

  return result;
}

/**
 * Cron-facing sweep: refreshes the clips whose Instagram or Facebook publish
 * happened within the configured window, staleness-first (never-fetched and
 * longest-stale rows first), one at a time up to a deadline.
 */
export async function runDueInsightsRefresh(
  options: InsightsRefreshOptions = {},
): Promise<InsightsRefreshSummary> {
  const db = options.db ?? getDb();
  const windowStart = new Date(
    Date.now() - config.insights.refreshWindowDays * 24 * 60 * 60 * 1000,
  );

  const due = await db
    .select({ clipId: clipPublications.clipId })
    .from(clipPublications)
    .leftJoin(
      clipPublicationInsights,
      eq(clipPublicationInsights.clipId, clipPublications.clipId),
    )
    .where(
      and(
        or(
          eq(clipPublications.instagramPublishStatus, "published"),
          eq(clipPublications.facebookPublishStatus, "published"),
        ),
        or(
          gte(clipPublications.instagramPublishedAt, windowStart),
          gte(clipPublications.facebookPublishedAt, windowStart),
        ),
      ),
    )
    .orderBy(
      asc(sql`coalesce(${clipPublicationInsights.updatedAt}, ${clipPublications.createdAt})`),
    )
    .limit(config.insights.batchSize);

  const summary: InsightsRefreshSummary = { attempted: 0, refreshed: 0, errored: 0 };
  const startedAt = Date.now();

  for (const row of due) {
    if (Date.now() - startedAt >= REFRESH_DEADLINE_MS) break;
    summary.attempted += 1;
    try {
      const result = await refreshInsightsForClip(row.clipId, { db });
      if (result.instagram === "refreshed" || result.facebook === "refreshed") {
        summary.refreshed += 1;
      }
      if (result.instagram === "error" || result.facebook === "error") {
        summary.errored += 1;
      }
    } catch (error) {
      summary.errored += 1;
      console.error("insights refresh failed:", error instanceof Error ? error.name : "UnknownError");
    }
  }

  return summary;
}
