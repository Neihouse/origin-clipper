import { sql } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import {
  claimNextDueScheduledPublish,
  markActiveClaimForManualReview,
  publishClaimedClip,
} from "./core";
import { SCHEDULED_PUBLISH_BATCH_SIZE } from "./policy";

export interface ScheduledPublishSummary {
  claimed: number;
  completed: number;
  failed: number;
  manualReview: number;
  stale: number;
  invalid: number;
  alreadyComplete: number;
}

interface ScheduledWorkerOptions {
  db?: Db;
}

interface CountRow {
  id: string;
}

function countRows(result: unknown): number {
  return (result as CountRow[]).length;
}

/**
 * Expired attempts never replay. Both-known-published is the sole state safe
 * to complete automatically; every other expired claim becomes manual review
 * and its pending platform states become manual review in the same transaction.
 */
export async function reconcileExpiredClaims(
  options: ScheduledWorkerOptions = {},
): Promise<{ stale: number; alreadyComplete: number }> {
  const db = options.db ?? getDb();
  return db.transaction(async (tx) => {
    const completeResult = await tx.execute(sql`
      WITH completed AS (
        UPDATE "publication_attempts" AS attempt
        SET
          "status" = 'completed',
          "error" = NULL,
          "locked_until" = NULL,
          "completed_at" = now(),
          "updated_at" = now()
        FROM "clip_publications" AS publication
        WHERE
          attempt."publication_id" = publication."id"
          AND attempt."status" = 'processing'
          AND (attempt."locked_until" IS NULL OR attempt."locked_until" < now())
          AND publication."instagram_publish_status" = 'published'
          AND publication."facebook_publish_status" = 'published'
        RETURNING attempt."clip_id"
      )
      UPDATE "clips"
      SET
        "status" = 'published',
        "published_at" = COALESCE("published_at", now()),
        "updated_at" = now()
      WHERE "id" IN (SELECT "clip_id" FROM completed)
      RETURNING "id"
    `);

    const staleResult = await tx.execute(sql`
      WITH stale AS (
        UPDATE "publication_attempts"
        SET
          "status" = 'manual_review',
          "error" = 'A publishing attempt timed out. Inspect both platforms before retrying.',
          "locked_until" = NULL,
          "completed_at" = now(),
          "updated_at" = now()
        WHERE
          "status" = 'processing'
          AND ("locked_until" IS NULL OR "locked_until" < now())
        RETURNING "id", "publication_id"
      )
      UPDATE "clip_publications" AS publication
      SET
        "instagram_publish_status" = CASE
          WHEN publication."instagram_publish_status" = 'pending'
            THEN 'manual_review'::"platform_publish_status"
          ELSE publication."instagram_publish_status"
        END,
        "facebook_publish_status" = CASE
          WHEN publication."facebook_publish_status" = 'pending'
            THEN 'manual_review'::"platform_publish_status"
          ELSE publication."facebook_publish_status"
        END,
        "updated_at" = now()
      WHERE publication."id" IN (SELECT "publication_id" FROM stale)
      RETURNING publication."id"
    `);
    return {
      alreadyComplete: countRows(completeResult),
      stale: countRows(staleResult),
    };
  });
}

/** Quarantines scheduled rows whose clip/platform prerequisites are no longer safe. */
export async function quarantineInvalidDueSchedules(
  options: ScheduledWorkerOptions = {},
): Promise<number> {
  const db = options.db ?? getDb();
  const result = await db.execute(sql`
    WITH invalid AS (
      UPDATE "publication_attempts" AS attempt
      SET
        "status" = 'manual_review',
        "error" = 'The scheduled publish authorization or platform state is incomplete.',
        "completed_at" = now(),
        "updated_at" = now()
      FROM "clips" AS clip, "clip_publications" AS publication
      WHERE
        attempt."clip_id" = clip."id"
        AND attempt."publication_id" = publication."id"
        AND attempt."status" = 'scheduled'
        AND (
          attempt."scheduled_for" IS NULL
          OR clip."status" <> 'approved'
          OR publication."instagram_publish_status" IN ('pending', 'manual_review')
          OR publication."facebook_publish_status" IN ('pending', 'manual_review')
        )
      RETURNING attempt."publication_id"
    )
    UPDATE "clip_publications" AS publication
    SET
      "instagram_publish_status" = CASE
        WHEN publication."instagram_publish_status" = 'pending'
          THEN 'manual_review'::"platform_publish_status"
        ELSE publication."instagram_publish_status"
      END,
      "facebook_publish_status" = CASE
        WHEN publication."facebook_publish_status" = 'pending'
          THEN 'manual_review'::"platform_publish_status"
        ELSE publication."facebook_publish_status"
      END,
      "updated_at" = now()
    WHERE publication."id" IN (SELECT "publication_id" FROM invalid)
    RETURNING publication."id"
  `);
  return countRows(result);
}

export async function runDueScheduledPublishes(
  limit = SCHEDULED_PUBLISH_BATCH_SIZE,
  options: ScheduledWorkerOptions = {},
): Promise<ScheduledPublishSummary> {
  if (!Number.isInteger(limit) || limit < 1 || limit > SCHEDULED_PUBLISH_BATCH_SIZE) {
    throw new Error(`Scheduled publish batch limit must be 1-${SCHEDULED_PUBLISH_BATCH_SIZE}.`);
  }
  const db = options.db ?? getDb();
  const recovered = await reconcileExpiredClaims({ db });
  const invalid = await quarantineInvalidDueSchedules({ db });
  const summary: ScheduledPublishSummary = {
    claimed: 0,
    completed: 0,
    failed: 0,
    manualReview: 0,
    stale: recovered.stale,
    invalid,
    alreadyComplete: recovered.alreadyComplete,
  };

  for (let index = 0; index < limit; index += 1) {
    const claim = await claimNextDueScheduledPublish({ db });
    if (!claim) break;
    summary.claimed += 1;
    try {
      const result = await publishClaimedClip(claim, { db });
      if (result.scheduleStatus === "completed") summary.completed += 1;
      if (result.scheduleStatus === "failed") summary.failed += 1;
      if (result.scheduleStatus === "manual_review") summary.manualReview += 1;
    } catch (error) {
      const marked = await markActiveClaimForManualReview(claim, undefined, { db });
      if (marked) summary.manualReview += 1;
      else summary.failed += 1;
      console.error("Scheduled clip publish stopped:", {
        clipId: claim.clipId,
        attemptId: claim.attemptId,
        name: error instanceof Error ? error.name : typeof error,
      });
    }
  }
  return summary;
}
