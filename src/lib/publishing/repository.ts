import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import {
  clipPublications,
  clips,
  publicationAttempts,
  type PublicationAttempt,
} from "@/db/schema";
import { config } from "@/lib/config";
import { PUBLISH_CLAIM_TTL_MS } from "./policy";

export interface PublishTargets {
  instagramUserId: string;
  facebookPageId: string;
}

export interface PublishingRepositoryOptions {
  db?: Db;
  targets?: PublishTargets;
}

export interface AttemptClaim {
  attemptId: string;
  clipId: string;
  publicationId: string;
  claimToken: string;
}

function resolveDb(options?: PublishingRepositoryOptions): Db {
  return options?.db ?? getDb();
}

function resolveTargets(options?: PublishingRepositoryOptions): PublishTargets {
  return (
    options?.targets ?? {
      instagramUserId: config.meta.igUserId,
      facebookPageId: config.meta.pageId,
    }
  );
}

function lockUntilSql() {
  return sql`now() + (${PUBLISH_CLAIM_TTL_MS} * interval '1 millisecond')`;
}

async function ensurePublicationInTransaction(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  clipId: string,
) {
  const [inserted] = await tx
    .insert(clipPublications)
    .values({ clipId })
    .onConflictDoNothing({ target: clipPublications.clipId })
    .returning();
  if (inserted) return inserted;
  const [existing] = await tx
    .select()
    .from(clipPublications)
    .where(eq(clipPublications.clipId, clipId))
    .limit(1);
  return existing;
}

interface AuthorizationSource {
  clipId: string;
  caption: string;
}

async function loadAuthorizationSource(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  clipId: string,
): Promise<AuthorizationSource | null> {
  const [source] = await tx
    .select({ clipId: clips.id, caption: clips.proposedCaption })
    .from(clips)
    .where(
      and(
        eq(clips.id, clipId),
        eq(clips.status, "approved"),
        isNotNull(clips.proposedCaption),
      ),
    )
    .limit(1);
  return source?.caption ? { clipId: source.clipId, caption: source.caption } : null;
}

function isAlreadyFullyPublished(publication: {
  instagramPublishStatus: string;
  facebookPublishStatus: string;
}): boolean {
  return (
    publication.instagramPublishStatus === "published" &&
    publication.facebookPublishStatus === "published"
  );
}

export async function authorizeScheduledPublish(
  clipId: string,
  scheduledFor: Date,
  options: PublishingRepositoryOptions = {},
): Promise<PublicationAttempt | null> {
  const db = resolveDb(options);
  const targets = resolveTargets(options);
  return db.transaction(async (tx) => {
    const source = await loadAuthorizationSource(tx, clipId);
    if (!source) return null;
    const publication = await ensurePublicationInTransaction(tx, clipId);
    if (!publication || isAlreadyFullyPublished(publication)) return null;

    const [attempt] = await tx
      .insert(publicationAttempts)
      .values({
        clipId,
        publicationId: publication.id,
        trigger: "scheduled",
        status: "scheduled",
        scheduledFor,
        authorizedAt: sql`now()`,
        authorizedCaption: source.caption,
        authorizedInstagramUserId: targets.instagramUserId,
        authorizedFacebookPageId: targets.facebookPageId,
      })
      .onConflictDoNothing()
      .returning();
    return attempt ?? null;
  });
}

/** Inserts a new immediate authorization already holding its processing claim. */
export async function claimImmediatePublish(
  clipId: string,
  options: PublishingRepositoryOptions = {},
): Promise<AttemptClaim | null> {
  const db = resolveDb(options);
  const targets = resolveTargets(options);
  const claimToken = randomUUID();
  return db.transaction(async (tx) => {
    const source = await loadAuthorizationSource(tx, clipId);
    if (!source) return null;
    const publication = await ensurePublicationInTransaction(tx, clipId);
    if (!publication || isAlreadyFullyPublished(publication)) return null;
    if (
      publication.instagramPublishStatus === "manual_review" ||
      publication.instagramPublishStatus === "pending" ||
      publication.facebookPublishStatus === "manual_review" ||
      publication.facebookPublishStatus === "pending"
    ) {
      return null;
    }

    const [attempt] = await tx
      .insert(publicationAttempts)
      .values({
        clipId,
        publicationId: publication.id,
        trigger: "immediate",
        status: "processing",
        scheduledFor: null,
        authorizedAt: sql`now()`,
        authorizedCaption: source.caption,
        authorizedInstagramUserId: targets.instagramUserId,
        authorizedFacebookPageId: targets.facebookPageId,
        claimToken,
        claimedAt: sql`now()`,
        lockedUntil: lockUntilSql(),
      })
      .onConflictDoNothing()
      .returning({
        attemptId: publicationAttempts.id,
        clipId: publicationAttempts.clipId,
        publicationId: publicationAttempts.publicationId,
      });
    return attempt ? { ...attempt, claimToken } : null;
  });
}

/** Claims the oldest due authorization in one atomic UPDATE...RETURNING. */
export async function claimNextDueScheduledPublish(
  options: Pick<PublishingRepositoryOptions, "db"> = {},
): Promise<AttemptClaim | null> {
  const db = resolveDb(options);
  const claimToken = randomUUID();
  const result = await db.execute(sql`
    UPDATE "publication_attempts" AS attempt
    SET
      "status" = 'processing',
      "claim_token" = ${claimToken},
      "claimed_at" = now(),
      "locked_until" = ${lockUntilSql()},
      "error" = NULL,
      "updated_at" = now()
    WHERE attempt."id" = (
      SELECT candidate."id"
      FROM "publication_attempts" AS candidate
      INNER JOIN "clips" AS clip ON clip."id" = candidate."clip_id"
      INNER JOIN "clip_publications" AS publication
        ON publication."id" = candidate."publication_id"
      WHERE
        candidate."status" = 'scheduled'
        AND candidate."scheduled_for" IS NOT NULL
        AND candidate."scheduled_for" <= now()
        AND clip."status" = 'approved'
        AND publication."instagram_publish_status" NOT IN ('pending', 'manual_review')
        AND publication."facebook_publish_status" NOT IN ('pending', 'manual_review')
        AND NOT (
          publication."instagram_publish_status" = 'published'
          AND publication."facebook_publish_status" = 'published'
        )
      ORDER BY candidate."scheduled_for" ASC, candidate."id" ASC
      FOR UPDATE OF candidate SKIP LOCKED
      LIMIT 1
    )
    AND attempt."status" = 'scheduled'
    RETURNING
      attempt."id" AS "attemptId",
      attempt."clip_id" AS "clipId",
      attempt."publication_id" AS "publicationId"
  `);
  const claimed = (
    result as unknown as Array<{
      attemptId: string;
      clipId: string;
      publicationId: string;
    }>
  )[0];
  return claimed ? { ...claimed, claimToken } : null;
}

export async function cancelScheduledAttempt(
  attemptId: string,
  options: Pick<PublishingRepositoryOptions, "db"> = {},
): Promise<boolean> {
  const db = resolveDb(options);
  const [cancelled] = await db
    .update(publicationAttempts)
    .set({ status: "cancelled", completedAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(eq(publicationAttempts.id, attemptId), eq(publicationAttempts.status, "scheduled")),
    )
    .returning({ id: publicationAttempts.id });
  return Boolean(cancelled);
}

/** Cancels the old authorization and appends a replacement in one transaction. */
export async function rescheduleScheduledAttempt(
  attemptId: string,
  scheduledFor: Date,
  options: PublishingRepositoryOptions = {},
): Promise<PublicationAttempt | null> {
  const db = resolveDb(options);
  const targets = resolveTargets(options);
  return db.transaction(async (tx) => {
    const [cancelled] = await tx
      .update(publicationAttempts)
      .set({ status: "cancelled", completedAt: sql`now()`, updatedAt: sql`now()` })
      .where(
        and(eq(publicationAttempts.id, attemptId), eq(publicationAttempts.status, "scheduled")),
      )
      .returning({
        clipId: publicationAttempts.clipId,
        publicationId: publicationAttempts.publicationId,
      });
    if (!cancelled) return null;

    const source = await loadAuthorizationSource(tx, cancelled.clipId);
    if (!source) throw new Error("RESCHEDULE_ROLLBACK");
    const [attempt] = await tx
      .insert(publicationAttempts)
      .values({
        clipId: cancelled.clipId,
        publicationId: cancelled.publicationId,
        trigger: "scheduled",
        status: "scheduled",
        scheduledFor,
        authorizedAt: sql`now()`,
        authorizedCaption: source.caption,
        authorizedInstagramUserId: targets.instagramUserId,
        authorizedFacebookPageId: targets.facebookPageId,
      })
      .onConflictDoNothing()
      .returning();
    if (!attempt) throw new Error("RESCHEDULE_ROLLBACK");
    return attempt;
  }).catch((error: unknown) => {
    if (error instanceof Error && error.message === "RESCHEDULE_ROLLBACK") return null;
    throw error;
  });
}

export async function findActiveAttemptForClip(
  clipId: string,
  options: Pick<PublishingRepositoryOptions, "db"> = {},
): Promise<PublicationAttempt | null> {
  const db = resolveDb(options);
  const [attempt] = await db
    .select()
    .from(publicationAttempts)
    .where(
      and(
        eq(publicationAttempts.clipId, clipId),
        inArray(publicationAttempts.status, ["scheduled", "processing", "manual_review"]),
      ),
    )
    .orderBy(sql`${publicationAttempts.createdAt} DESC`, sql`${publicationAttempts.id} DESC`)
    .limit(1);
  return attempt ?? null;
}
