import { desc, inArray, sql } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import {
  clipPublications,
  publicationAttempts,
  type ClipPublication,
  type ClipStatus,
  type PlatformPublishStatus,
  type PublicationAttempt,
  type ScheduleStatus,
} from "@/db/schema";

export interface ClipPublishingState {
  publicationId: string | null;
  latestAttemptId: string | null;
  scheduleStatus: ScheduleStatus;
  scheduledFor: Date | null;
  scheduleError: string | null;
  publishAttemptedAt: Date | null;
  videoAssetUrl: string | null;
  videoAssetEtag: string | null;
  videoAssetFetchedAt: Date | null;
  videoAssetError: string | null;
  instagramPublishStatus: PlatformPublishStatus;
  instagramContainerId: string | null;
  instagramMediaId: string | null;
  instagramPermalink: string | null;
  instagramPublishedAt: Date | null;
  instagramPublishError: string | null;
  facebookPublishStatus: PlatformPublishStatus;
  facebookPostId: string | null;
  facebookPermalink: string | null;
  facebookPublishedAt: Date | null;
  facebookPublishError: string | null;
  instagramCollaborationStatus: ClipPublication["instagramCollaborationStatus"];
  instagramCollaborationUpdatedAt: Date | null;
  publishVerifiedAt: Date | null;
  blobCleanupStatus: ClipPublication["blobCleanupStatus"];
  blobCleanupAttemptedAt: Date | null;
  blobDeletedAt: Date | null;
  blobCleanupError: string | null;
}

function emptyPublishingState(): ClipPublishingState {
  return {
    publicationId: null,
    latestAttemptId: null,
    scheduleStatus: "not_scheduled",
    scheduledFor: null,
    scheduleError: null,
    publishAttemptedAt: null,
    videoAssetUrl: null,
    videoAssetEtag: null,
    videoAssetFetchedAt: null,
    videoAssetError: null,
    instagramPublishStatus: "not_started",
    instagramContainerId: null,
    instagramMediaId: null,
    instagramPermalink: null,
    instagramPublishedAt: null,
    instagramPublishError: null,
    facebookPublishStatus: "not_started",
    facebookPostId: null,
    facebookPermalink: null,
    facebookPublishedAt: null,
    facebookPublishError: null,
    instagramCollaborationStatus: "not_requested",
    instagramCollaborationUpdatedAt: null,
    publishVerifiedAt: null,
    blobCleanupStatus: "retained",
    blobCleanupAttemptedAt: null,
    blobDeletedAt: null,
    blobCleanupError: null,
  };
}

function combinePublishingState(
  publication: ClipPublication | undefined,
  latestAttempt: PublicationAttempt | undefined,
): ClipPublishingState {
  const base = emptyPublishingState();
  return {
    ...base,
    ...(publication
      ? {
          publicationId: publication.id,
          videoAssetUrl: publication.videoAssetUrl,
          videoAssetEtag: publication.videoAssetEtag,
          videoAssetFetchedAt: publication.videoAssetFetchedAt,
          videoAssetError: publication.videoAssetError,
          instagramPublishStatus: publication.instagramPublishStatus,
          instagramContainerId: publication.instagramContainerId,
          instagramMediaId: publication.instagramMediaId,
          instagramPermalink: publication.instagramPermalink,
          instagramPublishedAt: publication.instagramPublishedAt,
          instagramPublishError: publication.instagramPublishError,
          facebookPublishStatus: publication.facebookPublishStatus,
          facebookPostId: publication.facebookPostId,
          facebookPermalink: publication.facebookPermalink,
          facebookPublishedAt: publication.facebookPublishedAt,
          facebookPublishError: publication.facebookPublishError,
          instagramCollaborationStatus: publication.instagramCollaborationStatus,
          instagramCollaborationUpdatedAt: publication.instagramCollaborationUpdatedAt,
          publishVerifiedAt: publication.publishVerifiedAt,
          blobCleanupStatus: publication.blobCleanupStatus,
          blobCleanupAttemptedAt: publication.blobCleanupAttemptedAt,
          blobDeletedAt: publication.blobDeletedAt,
          blobCleanupError: publication.blobCleanupError,
        }
      : {}),
    ...(latestAttempt
      ? {
          latestAttemptId: latestAttempt.id,
          scheduleStatus: latestAttempt.status,
          scheduledFor: latestAttempt.scheduledFor,
          scheduleError: latestAttempt.error,
          publishAttemptedAt: latestAttempt.claimedAt,
        }
      : {}),
  };
}

export async function getPublishingStatesForClipIds(
  clipIds: string[],
  db: Db = getDb(),
): Promise<Map<string, ClipPublishingState>> {
  const states = new Map<string, ClipPublishingState>();
  for (const clipId of clipIds) states.set(clipId, emptyPublishingState());
  if (clipIds.length === 0) return states;

  const [publications, latestAttempts] = await Promise.all([
    db.select().from(clipPublications).where(inArray(clipPublications.clipId, clipIds)),
    db
      .selectDistinctOn([publicationAttempts.clipId])
      .from(publicationAttempts)
      .where(inArray(publicationAttempts.clipId, clipIds))
      .orderBy(
        publicationAttempts.clipId,
        desc(publicationAttempts.createdAt),
        desc(publicationAttempts.id),
      ),
  ]);

  const publicationByClip = new Map(publications.map((row) => [row.clipId, row]));
  const attemptByClip = new Map(latestAttempts.map((row) => [row.clipId, row]));
  for (const clipId of clipIds) {
    states.set(
      clipId,
      combinePublishingState(publicationByClip.get(clipId), attemptByClip.get(clipId)),
    );
  }
  return states;
}

export async function getPublishingStateForClip(
  clipId: string,
  db: Db = getDb(),
): Promise<ClipPublishingState> {
  return (await getPublishingStatesForClipIds([clipId], db)).get(clipId) ?? emptyPublishingState();
}

export async function getPublicationAttemptHistory(
  clipId: string,
  db: Db = getDb(),
): Promise<PublicationAttempt[]> {
  return db
    .select()
    .from(publicationAttempts)
    .where(inArray(publicationAttempts.clipId, [clipId]))
    .orderBy(desc(publicationAttempts.createdAt), desc(publicationAttempts.id));
}

export interface CadencePublishingRow {
  clipId: string;
  title: string;
  creatorName: string;
  clipStatus: ClipStatus;
  publishing: ClipPublishingState;
}

interface CadenceQueryInput {
  now: Date;
  horizon: Date;
  limit?: number;
}

export interface CadencePublishingMetrics {
  upcomingScheduledCount: number;
  nextDueAt: Date | null;
  approvedUnscheduledCount: number;
  overdueCount: number;
  failedCount: number;
  manualReviewCount: number;
  processingCount: number;
  cleanupFailedCount: number;
  collaborationFollowUpCount: number;
  unverifiedCount: number;
  postPublishFollowUpCount: number;
  operatorAttentionCount: number;
}

export interface CadencePublishingDashboard {
  rows: CadencePublishingRow[];
  totalCount: number;
  metrics: CadencePublishingMetrics;
}

interface CadenceDashboardSqlRow {
  clipId: string | null;
  title: string | null;
  creatorName: string | null;
  clipStatus: ClipStatus | null;
  totalCount: number | string;
  upcomingScheduledCount: number | string;
  nextDueAt: Date | string | null;
  approvedUnscheduledCount: number | string;
  overdueCount: number | string;
  failedCount: number | string;
  manualReviewCount: number | string;
  processingCount: number | string;
  cleanupFailedCount: number | string;
  collaborationFollowUpCount: number | string;
  unverifiedCount: number | string;
  postPublishFollowUpCount: number | string;
  operatorAttentionCount: number | string;
}

function countValue(value: number | string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Exact latest-attempt cadence aggregate plus a bounded actionable queue.
 *
 * One SQL statement computes metrics over every approved/published clip and
 * applies the deterministic attention/time/id LIMIT in Postgres. There is no
 * source cap or JS-side filtering that could silently approximate counts.
 */
export async function getCadencePublishingDashboard(
  { now, horizon, limit = 50 }: CadenceQueryInput,
  db: Db = getDb(),
): Promise<CadencePublishingDashboard> {
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(horizon.getTime()) || horizon < now) {
    throw new Error("Cadence dashboard requires a valid current time and future horizon.");
  }
  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 50));
  // Raw sql`` interpolation hands the postgres driver a bare parameter with no
  // column type context; a JS Date is rejected outright, so timestamps must be
  // passed as ISO strings for Postgres to parse as timestamptz.
  const nowIso = now.toISOString();
  const horizonIso = horizon.toISOString();
  const result = await db.execute(sql`
    WITH base AS (
      SELECT
        clip."id" AS "clipId",
        clip."title" AS "title",
        clip."creator_name" AS "creatorName",
        clip."status" AS "clipStatus",
        attempt."status" AS "attemptStatus",
        attempt."scheduled_for" AS "scheduledFor",
        attempt."claimed_at" AS "claimedAt",
        attempt."created_at" AS "attemptCreatedAt",
        publication."blob_cleanup_status" AS "cleanupStatus",
        publication."instagram_collaboration_status" AS "collaborationStatus",
        publication."publish_verified_at" AS "publishVerifiedAt",
        publication."updated_at" AS "publicationUpdatedAt",
        COALESCE(publication."instagram_publish_status" = 'published', false)
          AND COALESCE(publication."facebook_publish_status" = 'published', false)
          AS "fullyPublished"
      FROM "clips" AS clip
      LEFT JOIN "clip_publications" AS publication
        ON publication."clip_id" = clip."id"
      LEFT JOIN LATERAL (
        SELECT candidate.*
        FROM "publication_attempts" AS candidate
        WHERE candidate."clip_id" = clip."id"
        ORDER BY candidate."created_at" DESC, candidate."id" DESC
        LIMIT 1
      ) AS attempt ON true
      WHERE clip."status" IN ('approved', 'published')
    ), classified AS (
      SELECT
        base.*,
        (
          base."cleanupStatus" = 'failed'
          OR (
            base."fullyPublished"
            AND (
              base."collaborationStatus" IS DISTINCT FROM 'accepted'
              OR base."publishVerifiedAt" IS NULL
            )
          )
          OR base."attemptStatus" IN ('processing', 'failed', 'manual_review')
          OR (
            base."attemptStatus" = 'scheduled'
            AND base."scheduledFor" IS NOT NULL
            AND base."scheduledFor" <= ${horizonIso}
          )
        ) AS "queueEligible",
        CASE
          WHEN base."attemptStatus" = 'manual_review' THEN 0
          WHEN base."attemptStatus" = 'scheduled' AND base."scheduledFor" < ${nowIso} THEN 1
          WHEN base."attemptStatus" = 'processing' THEN 2
          WHEN base."attemptStatus" = 'failed' THEN 3
          WHEN base."cleanupStatus" = 'failed' THEN 4
          WHEN base."fullyPublished" AND (
            base."collaborationStatus" IS DISTINCT FROM 'accepted'
            OR base."publishVerifiedAt" IS NULL
          ) THEN 5
          ELSE 6
        END AS "attentionPriority",
        COALESCE(
          base."scheduledFor",
          base."claimedAt",
          base."attemptCreatedAt",
          base."publicationUpdatedAt",
          'infinity'::timestamptz
        ) AS "queueTime"
      FROM base
    ), metrics AS (
      SELECT
        COUNT(*) FILTER (WHERE classified."queueEligible") AS "totalCount",
        COUNT(*) FILTER (
          WHERE classified."attemptStatus" = 'scheduled'
            AND classified."scheduledFor" >= ${nowIso}
            AND classified."scheduledFor" <= ${horizonIso}
        ) AS "upcomingScheduledCount",
        MIN(classified."scheduledFor") FILTER (
          WHERE classified."attemptStatus" = 'scheduled'
            AND classified."scheduledFor" >= ${nowIso}
        ) AS "nextDueAt",
        COUNT(*) FILTER (
          WHERE classified."clipStatus" = 'approved'
            AND NOT classified."fullyPublished"
            AND (
              classified."attemptStatus" IS NULL
              OR classified."attemptStatus" IN ('cancelled', 'completed')
            )
        ) AS "approvedUnscheduledCount",
        COUNT(*) FILTER (
          WHERE classified."attemptStatus" = 'scheduled'
            AND classified."scheduledFor" < ${nowIso}
        ) AS "overdueCount",
        COUNT(*) FILTER (WHERE classified."attemptStatus" = 'failed') AS "failedCount",
        COUNT(*) FILTER (WHERE classified."attemptStatus" = 'manual_review') AS "manualReviewCount",
        COUNT(*) FILTER (WHERE classified."attemptStatus" = 'processing') AS "processingCount",
        COUNT(*) FILTER (WHERE classified."cleanupStatus" = 'failed') AS "cleanupFailedCount",
        COUNT(*) FILTER (
          WHERE classified."fullyPublished"
            AND classified."collaborationStatus" IS DISTINCT FROM 'accepted'
        ) AS "collaborationFollowUpCount",
        COUNT(*) FILTER (
          WHERE classified."fullyPublished"
            AND classified."publishVerifiedAt" IS NULL
        ) AS "unverifiedCount",
        COUNT(*) FILTER (
          WHERE classified."fullyPublished"
            AND (
              classified."collaborationStatus" IS DISTINCT FROM 'accepted'
              OR classified."publishVerifiedAt" IS NULL
            )
        ) AS "postPublishFollowUpCount",
        COUNT(*) FILTER (
          WHERE classified."cleanupStatus" = 'failed'
            OR classified."attemptStatus" IN ('processing', 'failed', 'manual_review')
            OR (
              classified."attemptStatus" = 'scheduled'
              AND classified."scheduledFor" < ${nowIso}
            )
            OR (
              classified."fullyPublished"
              AND (
                classified."collaborationStatus" IS DISTINCT FROM 'accepted'
                OR classified."publishVerifiedAt" IS NULL
              )
            )
        ) AS "operatorAttentionCount"
      FROM classified
    ), queue AS (
      SELECT *
      FROM classified
      WHERE classified."queueEligible"
      ORDER BY
        classified."attentionPriority" ASC,
        classified."queueTime" ASC,
        classified."clipId" ASC
      LIMIT ${boundedLimit}
    )
    SELECT
      queue."clipId",
      queue."title",
      queue."creatorName",
      queue."clipStatus",
      metrics."totalCount",
      metrics."upcomingScheduledCount",
      metrics."nextDueAt",
      metrics."approvedUnscheduledCount",
      metrics."overdueCount",
      metrics."failedCount",
      metrics."manualReviewCount",
      metrics."processingCount",
      metrics."cleanupFailedCount",
      metrics."collaborationFollowUpCount",
      metrics."unverifiedCount",
      metrics."postPublishFollowUpCount",
      metrics."operatorAttentionCount"
    FROM metrics
    LEFT JOIN queue ON true
    ORDER BY
      queue."attentionPriority" ASC NULLS LAST,
      queue."queueTime" ASC NULLS LAST,
      queue."clipId" ASC NULLS LAST
  `);
  const rawRows = result as unknown as CadenceDashboardSqlRow[];
  const aggregate = rawRows[0] ?? {
    totalCount: 0,
    upcomingScheduledCount: 0,
    nextDueAt: null,
    approvedUnscheduledCount: 0,
    overdueCount: 0,
    failedCount: 0,
    manualReviewCount: 0,
    processingCount: 0,
    cleanupFailedCount: 0,
    collaborationFollowUpCount: 0,
    unverifiedCount: 0,
    postPublishFollowUpCount: 0,
    operatorAttentionCount: 0,
  };
  const queueRows = rawRows.filter(
    (row): row is CadenceDashboardSqlRow & {
      clipId: string;
      title: string;
      creatorName: string;
      clipStatus: ClipStatus;
    } => Boolean(row.clipId && row.title && row.creatorName && row.clipStatus),
  );
  const states = await getPublishingStatesForClipIds(
    queueRows.map((row) => row.clipId),
    db,
  );
  return {
    rows: queueRows.map((row) => ({
      clipId: row.clipId,
      title: row.title,
      creatorName: row.creatorName,
      clipStatus: row.clipStatus,
      publishing: states.get(row.clipId) ?? emptyPublishingState(),
    })),
    totalCount: countValue(aggregate.totalCount),
    metrics: {
      upcomingScheduledCount: countValue(aggregate.upcomingScheduledCount),
      nextDueAt: aggregate.nextDueAt ? new Date(aggregate.nextDueAt) : null,
      approvedUnscheduledCount: countValue(aggregate.approvedUnscheduledCount),
      overdueCount: countValue(aggregate.overdueCount),
      failedCount: countValue(aggregate.failedCount),
      manualReviewCount: countValue(aggregate.manualReviewCount),
      processingCount: countValue(aggregate.processingCount),
      cleanupFailedCount: countValue(aggregate.cleanupFailedCount),
      collaborationFollowUpCount: countValue(aggregate.collaborationFollowUpCount),
      unverifiedCount: countValue(aggregate.unverifiedCount),
      postPublishFollowUpCount: countValue(aggregate.postPublishFollowUpCount),
      operatorAttentionCount: countValue(aggregate.operatorAttentionCount),
    },
  };
}

/** Compatibility wrapper for callers that only need the bounded rows. */
export async function getCadencePublishingRows(
  input: CadenceQueryInput,
  db: Db = getDb(),
): Promise<CadencePublishingRow[]> {
  return (await getCadencePublishingDashboard(input, db)).rows;
}
