import { randomUUID } from "node:crypto";
import { del } from "@vercel/blob";
import { and, eq, sql } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { clipPublications } from "@/db/schema";
import { config } from "@/lib/config";

const CLEANUP_BATCH_SIZE = 5;
const CLEANUP_LOCK_TTL_MS = 2 * 60_000;
const FAILED_RETRY_DELAY_MS = 12 * 60 * 60_000;
const BLOB_DELETE_TIMEOUT_MS = 15_000;

export interface BlobCleanupClaim {
  publicationId: string;
  claimToken: string;
  videoAssetUrl: string;
  videoAssetEtag: string;
}

export interface BlobCleanupSummary {
  claimed: number;
  deleted: number;
  failed: number;
  stale: number;
}

interface BlobCleanupOptions {
  db?: Db;
  retentionDays?: number;
  deleteAsset?: (url: string, etag: string) => Promise<void>;
}

function cleanupLockSql() {
  return sql`now() + (${CLEANUP_LOCK_TTL_MS} * interval '1 millisecond')`;
}

function requireRetentionDays(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 30) {
    throw new Error("Blob retention must be an integer from 1 to 30 days.");
  }
  return value;
}

/** Makes an interrupted delete retryable. Vercel Blob deletion is idempotent. */
export async function reconcileStaleBlobCleanupClaims(db: Db = getDb()): Promise<number> {
  const result = await db.execute(sql`
    UPDATE "clip_publications"
    SET
      "blob_cleanup_status" = 'failed',
      "blob_cleanup_claim_token" = NULL,
      "blob_cleanup_locked_until" = NULL,
      "blob_cleanup_error" = 'The prior cleanup lease expired before completion.',
      "updated_at" = now()
    WHERE
      "blob_cleanup_status" = 'processing'
      AND "blob_cleanup_locked_until" IS NOT NULL
      AND "blob_cleanup_locked_until" <= now()
    RETURNING "id"
  `);
  return (result as unknown as Array<{ id: string }>).length;
}

/**
 * Claims one exact, verified asset. An active publication authorization keeps
 * the asset ineligible, and failed cleanup is cooled down so a single cron run
 * cannot hot-loop on the same Blob error.
 */
export async function claimNextBlobCleanup(
  options: Pick<BlobCleanupOptions, "db" | "retentionDays"> = {},
): Promise<BlobCleanupClaim | null> {
  const retentionDays = requireRetentionDays(options.retentionDays ?? config.blob.retentionDays);
  const db = options.db ?? getDb();
  const claimToken = randomUUID();
  const result = await db.execute(sql`
    UPDATE "clip_publications" AS publication
    SET
      "blob_cleanup_status" = 'processing',
      "blob_cleanup_claim_token" = ${claimToken},
      "blob_cleanup_locked_until" = ${cleanupLockSql()},
      "blob_cleanup_attempted_at" = now(),
      "blob_cleanup_error" = NULL,
      "updated_at" = now()
    WHERE publication."id" = (
      SELECT candidate."id"
      FROM "clip_publications" AS candidate
      WHERE
        candidate."video_asset_url" IS NOT NULL
        AND candidate."video_asset_etag" IS NOT NULL
        AND candidate."publish_verified_at" IS NOT NULL
        AND candidate."publish_verified_at" <= now() - (${retentionDays} * interval '1 day')
        AND candidate."instagram_publish_status" = 'published'
        AND candidate."facebook_publish_status" = 'published'
        AND EXISTS (
          SELECT 1
          FROM "clips" AS clip
          WHERE clip."id" = candidate."clip_id" AND clip."status" = 'published'
        )
        AND candidate."blob_cleanup_status" IN ('retained', 'failed')
        AND (
          candidate."blob_cleanup_status" = 'retained'
          OR candidate."blob_cleanup_attempted_at" IS NULL
          OR candidate."blob_cleanup_attempted_at" <= now() - (${FAILED_RETRY_DELAY_MS} * interval '1 millisecond')
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "publication_attempts" AS attempt
          WHERE
            attempt."publication_id" = candidate."id"
            AND attempt."status" IN ('scheduled', 'processing', 'manual_review')
        )
      ORDER BY candidate."publish_verified_at" ASC, candidate."id" ASC
      FOR UPDATE OF candidate SKIP LOCKED
      LIMIT 1
    )
    AND publication."blob_cleanup_status" IN ('retained', 'failed')
    RETURNING
      publication."id" AS "publicationId",
      publication."video_asset_url" AS "videoAssetUrl",
      publication."video_asset_etag" AS "videoAssetEtag"
  `);
  const claimed = (
    result as unknown as Array<{
      publicationId: string;
      videoAssetUrl: string;
      videoAssetEtag: string;
    }>
  )[0];
  return claimed ? { ...claimed, claimToken } : null;
}

async function deleteBlobAsset(url: string, etag: string): Promise<void> {
  await del(url, {
    token: config.blob.readWriteToken,
    ifMatch: etag,
    abortSignal: AbortSignal.timeout(BLOB_DELETE_TIMEOUT_MS),
  });
}

async function completeBlobCleanup(claim: BlobCleanupClaim, db: Db): Promise<boolean> {
  const [updated] = await db
    .update(clipPublications)
    .set({
      blobCleanupStatus: "deleted",
      blobCleanupClaimToken: null,
      blobCleanupLockedUntil: null,
      blobDeletedAt: sql`now()`,
      blobCleanupError: null,
      videoAssetUrl: null,
      videoAssetEtag: null,
      videoAssetError: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(clipPublications.id, claim.publicationId),
        eq(clipPublications.blobCleanupStatus, "processing"),
        eq(clipPublications.blobCleanupClaimToken, claim.claimToken),
        eq(clipPublications.videoAssetUrl, claim.videoAssetUrl),
        eq(clipPublications.videoAssetEtag, claim.videoAssetEtag),
      ),
    )
    .returning({ id: clipPublications.id });
  return Boolean(updated);
}

async function failBlobCleanup(claim: BlobCleanupClaim, db: Db): Promise<void> {
  await db
    .update(clipPublications)
    .set({
      blobCleanupStatus: "failed",
      blobCleanupClaimToken: null,
      blobCleanupLockedUntil: null,
      blobCleanupError: "Blob deletion failed and will be retried after the cleanup cooldown.",
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(clipPublications.id, claim.publicationId),
        eq(clipPublications.blobCleanupStatus, "processing"),
        eq(clipPublications.blobCleanupClaimToken, claim.claimToken),
        eq(clipPublications.videoAssetUrl, claim.videoAssetUrl),
        eq(clipPublications.videoAssetEtag, claim.videoAssetEtag),
      ),
    );
}

export async function runVerifiedBlobCleanup(
  options: BlobCleanupOptions = {},
): Promise<BlobCleanupSummary> {
  const db = options.db ?? getDb();
  const deleteAsset = options.deleteAsset ?? deleteBlobAsset;
  const summary: BlobCleanupSummary = {
    claimed: 0,
    deleted: 0,
    failed: 0,
    stale: await reconcileStaleBlobCleanupClaims(db),
  };

  for (let index = 0; index < CLEANUP_BATCH_SIZE; index += 1) {
    const claim = await claimNextBlobCleanup({ db, retentionDays: options.retentionDays });
    if (!claim) break;
    summary.claimed += 1;
    try {
      await deleteAsset(claim.videoAssetUrl, claim.videoAssetEtag);
      if (await completeBlobCleanup(claim, db)) summary.deleted += 1;
      else summary.failed += 1;
    } catch {
      await failBlobCleanup(claim, db);
      summary.failed += 1;
    }
  }
  return summary;
}
