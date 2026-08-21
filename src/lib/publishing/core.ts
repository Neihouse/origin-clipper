import { and, eq, exists, sql } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import {
  clipPublications,
  clips,
  publicationAttempts,
  type Clip,
  type ClipPublication,
  type NewClipPublication,
  type NewPublicationAttempt,
  type PlatformPublishStatus,
  type PublicationAttempt,
} from "@/db/schema";
import { config } from "@/lib/config";
import { rehostClipVideo } from "@/lib/media/rehost-clip-video";
import { getVideoPermalink, publishPageVideo } from "@/lib/meta/facebook";
import {
  createReelsContainer,
  getMediaPermalink,
  pollContainerStatus,
  publishContainer,
} from "@/lib/meta/instagram";
import { MetaGraphApiError } from "@/lib/meta/client";
import { fetchClipSourceVideoUrl } from "@/lib/twitch/unofficial-clip-video";
import { type AttemptClaim, type PublishTargets } from "./repository";
import { resolveAuthorizedPublishContext, resolveScheduleOutcome } from "./policy";

export { claimImmediatePublish, claimNextDueScheduledPublish } from "./repository";
export type { AttemptClaim as PublishClaim } from "./repository";

export interface PublishPlatformResult {
  status: "skipped" | "published" | "failed" | "manual_review";
  permalink?: string;
  error?: string;
}

export interface PublishCoreResult {
  instagram: PublishPlatformResult;
  facebook: PublishPlatformResult;
  allPublished: boolean;
  scheduleStatus: "completed" | "failed" | "manual_review";
}

export class PublishClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishClaimError";
  }
}

interface PublishingRuntimeOptions {
  db?: Db;
  targets?: PublishTargets;
}

interface ActivePublicationContext {
  clip: Clip;
  attempt: PublicationAttempt;
  publication: ClipPublication;
}

function runtimeDb(options?: PublishingRuntimeOptions): Db {
  return options?.db ?? getDb();
}

function runtimeTargets(options?: PublishingRuntimeOptions): PublishTargets {
  return (
    options?.targets ?? {
      instagramUserId: config.meta.igUserId,
      facebookPageId: config.meta.pageId,
    }
  );
}

async function loadActiveClaim(
  claim: AttemptClaim,
  db: Db,
): Promise<ActivePublicationContext> {
  const [row] = await db
    .select({ clip: clips, attempt: publicationAttempts, publication: clipPublications })
    .from(publicationAttempts)
    .innerJoin(clips, eq(clips.id, publicationAttempts.clipId))
    .innerJoin(clipPublications, eq(clipPublications.id, publicationAttempts.publicationId))
    .where(
      and(
        eq(publicationAttempts.id, claim.attemptId),
        eq(publicationAttempts.clipId, claim.clipId),
        eq(publicationAttempts.publicationId, claim.publicationId),
        eq(publicationAttempts.claimToken, claim.claimToken),
        eq(publicationAttempts.status, "processing"),
        sql`${publicationAttempts.lockedUntil} > now()`,
      ),
    )
    .limit(1);
  if (!row) throw new PublishClaimError("This publish is no longer the active attempt.");
  return row;
}

async function updateActiveAttempt(
  claim: AttemptClaim,
  values: Partial<NewPublicationAttempt>,
  db: Db,
): Promise<void> {
  const [updated] = await db
    .update(publicationAttempts)
    .set({ ...values, updatedAt: new Date() })
    .where(
      and(
        eq(publicationAttempts.id, claim.attemptId),
        eq(publicationAttempts.clipId, claim.clipId),
        eq(publicationAttempts.publicationId, claim.publicationId),
        eq(publicationAttempts.claimToken, claim.claimToken),
        eq(publicationAttempts.status, "processing"),
        sql`${publicationAttempts.lockedUntil} > now()`,
      ),
    )
    .returning({ id: publicationAttempts.id });
  if (!updated) throw new PublishClaimError("This publish claim expired before it could be saved.");
}

function activeAttemptExists(claim: AttemptClaim, db: Db) {
  return exists(
    db
      .select({ one: sql`1` })
      .from(publicationAttempts)
      .where(
        and(
          eq(publicationAttempts.id, claim.attemptId),
          eq(publicationAttempts.clipId, claim.clipId),
          eq(publicationAttempts.publicationId, claim.publicationId),
          eq(publicationAttempts.claimToken, claim.claimToken),
          eq(publicationAttempts.status, "processing"),
          sql`${publicationAttempts.lockedUntil} > now()`,
        ),
      ),
  );
}

/** Every durable platform/asset write proves the owning attempt claim is active. */
async function updatePublicationForActiveClaim(
  claim: AttemptClaim,
  values: Partial<NewClipPublication>,
  db: Db,
): Promise<void> {
  const [updated] = await db
    .update(clipPublications)
    .set({ ...values, updatedAt: new Date() })
    .where(
      and(
        eq(clipPublications.id, claim.publicationId),
        eq(clipPublications.clipId, claim.clipId),
        activeAttemptExists(claim, db),
      ),
    )
    .returning({ id: clipPublications.id });
  if (!updated) throw new PublishClaimError("This publish claim expired before it could be saved.");
}

/** Fail-closed escape hatch for an unexpected worker error. */
export async function markActiveClaimForManualReview(
  claim: AttemptClaim,
  message = "Publishing stopped before the outcome could be confirmed.",
  options: Pick<PublishingRuntimeOptions, "db"> = {},
): Promise<boolean> {
  const db = runtimeDb(options);
  return db.transaction(async (tx) => {
    await tx
      .update(clipPublications)
      .set({
        instagramPublishStatus: sql`
          CASE
            WHEN ${clipPublications.instagramPublishStatus} = 'pending'
              THEN 'manual_review'::"platform_publish_status"
            ELSE ${clipPublications.instagramPublishStatus}
          END
        `,
        facebookPublishStatus: sql`
          CASE
            WHEN ${clipPublications.facebookPublishStatus} = 'pending'
              THEN 'manual_review'::"platform_publish_status"
            ELSE ${clipPublications.facebookPublishStatus}
          END
        `,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(clipPublications.id, claim.publicationId),
          exists(
            tx
              .select({ one: sql`1` })
              .from(publicationAttempts)
              .where(
                and(
                  eq(publicationAttempts.id, claim.attemptId),
                  eq(publicationAttempts.clipId, claim.clipId),
                  eq(publicationAttempts.publicationId, claim.publicationId),
                  eq(publicationAttempts.claimToken, claim.claimToken),
                  eq(publicationAttempts.status, "processing"),
                ),
              ),
          ),
        ),
      );
    const [updated] = await tx
      .update(publicationAttempts)
      .set({
        status: "manual_review",
        error: message,
        lockedUntil: null,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(publicationAttempts.id, claim.attemptId),
          eq(publicationAttempts.clipId, claim.clipId),
          eq(publicationAttempts.publicationId, claim.publicationId),
          eq(publicationAttempts.claimToken, claim.claimToken),
          eq(publicationAttempts.status, "processing"),
        ),
      )
      .returning({ id: publicationAttempts.id });
    return Boolean(updated);
  });
}

function safeGraphError(error: MetaGraphApiError): string {
  const subcode = error.errorSubcode ? `/${error.errorSubcode}` : "";
  return `Meta rejected the request (code ${error.code}${subcode}).`;
}

function safeFailure(error: unknown): string {
  if (error instanceof MetaGraphApiError) return safeGraphError(error);
  return "The platform request failed before publication could be confirmed.";
}

function isAmbiguousPostError(error: unknown): boolean {
  return !(error instanceof MetaGraphApiError);
}

async function acquireVideoAsset(
  claim: AttemptClaim,
  context: ActivePublicationContext,
  db: Db,
): Promise<string> {
  const { clip, publication } = context;
  if (
    publication.videoAssetUrl &&
    publication.blobCleanupStatus !== "deleted" &&
    publication.blobCleanupStatus !== "processing"
  ) {
    return publication.videoAssetUrl;
  }

  try {
    const source = await fetchClipSourceVideoUrl(clip.twitchClipId);
    const rehosted = await rehostClipVideo(source.videoUrl, `clips/${clip.twitchClipId}.mp4`);
    await updatePublicationForActiveClaim(
      claim,
      {
        videoAssetUrl: rehosted.url,
        videoAssetEtag: rehosted.etag,
        videoAssetFetchedAt: new Date(),
        videoAssetError: null,
        blobCleanupStatus: "retained",
        blobCleanupClaimToken: null,
        blobCleanupLockedUntil: null,
        blobCleanupAttemptedAt: null,
        blobDeletedAt: null,
        blobCleanupError: null,
      },
      db,
    );
    return rehosted.url;
  } catch (error) {
    await updatePublicationForActiveClaim(
      claim,
      { videoAssetError: error instanceof Error ? error.message : "Video acquisition failed." },
      db,
    );
    throw new PublishClaimError("Could not acquire the clip video.");
  }
}

async function attemptInstagramPublish(
  claim: AttemptClaim,
  context: ActivePublicationContext,
  videoAssetUrl: string,
  db: Db,
): Promise<PublishPlatformResult> {
  const { attempt, publication } = context;
  if (publication.instagramPublishStatus === "published") {
    return { status: "skipped", permalink: publication.instagramPermalink ?? undefined };
  }

  await updatePublicationForActiveClaim(
    claim,
    { instagramPublishStatus: "pending", instagramPublishError: null },
    db,
  );

  let containerId = publication.instagramContainerId;
  if (!containerId) {
    try {
      containerId = await createReelsContainer({
        igUserId: attempt.authorizedInstagramUserId,
        videoUrl: videoAssetUrl,
        caption: attempt.authorizedCaption,
      });
      await updatePublicationForActiveClaim(claim, { instagramContainerId: containerId }, db);
    } catch (error) {
      const ambiguous = isAmbiguousPostError(error);
      await updatePublicationForActiveClaim(
        claim,
        {
          instagramPublishStatus: ambiguous ? "manual_review" : "failed",
          instagramPublishError: safeFailure(error),
        },
        db,
      );
      return { status: ambiguous ? "manual_review" : "failed", error: safeFailure(error) };
    }
  }

  let statusCode: Awaited<ReturnType<typeof pollContainerStatus>>;
  try {
    statusCode = await pollContainerStatus(containerId);
  } catch (error) {
    await updatePublicationForActiveClaim(
      claim,
      { instagramPublishStatus: "failed", instagramPublishError: safeFailure(error) },
      db,
    );
    return { status: "failed", error: safeFailure(error) };
  }

  if (statusCode === "PUBLISHED") {
    await updatePublicationForActiveClaim(
      claim,
      {
        instagramPublishStatus: "published",
        instagramPublishedAt: new Date(),
        instagramPublishError: null,
      },
      db,
    );
    return { status: "published", permalink: publication.instagramPermalink ?? undefined };
  }
  if (statusCode !== "FINISHED") {
    const message = `Instagram container is ${statusCode.toLowerCase()}.`;
    await updatePublicationForActiveClaim(
      claim,
      {
        instagramPublishStatus: "failed",
        instagramContainerId: null,
        instagramPublishError: message,
      },
      db,
    );
    return { status: "failed", error: message };
  }

  try {
    const mediaId = await publishContainer({
      igUserId: attempt.authorizedInstagramUserId,
      containerId,
    });
    await updatePublicationForActiveClaim(
      claim,
      {
        instagramPublishStatus: "published",
        instagramMediaId: mediaId,
        instagramPublishedAt: new Date(),
        instagramPublishError: null,
      },
      db,
    );
    const permalink = await getMediaPermalink(mediaId);
    if (permalink) {
      try {
        await updatePublicationForActiveClaim(claim, { instagramPermalink: permalink }, db);
      } catch {
        // Published id/status is already durable.
      }
    }
    return { status: "published", permalink };
  } catch (error) {
    const ambiguous = isAmbiguousPostError(error);
    await updatePublicationForActiveClaim(
      claim,
      {
        instagramPublishStatus: ambiguous ? "manual_review" : "failed",
        instagramPublishError: safeFailure(error),
      },
      db,
    );
    return { status: ambiguous ? "manual_review" : "failed", error: safeFailure(error) };
  }
}

async function attemptFacebookPublish(
  claim: AttemptClaim,
  context: ActivePublicationContext,
  videoAssetUrl: string,
  db: Db,
): Promise<PublishPlatformResult> {
  const { attempt, publication } = context;
  if (publication.facebookPublishStatus === "published") {
    return { status: "skipped", permalink: publication.facebookPermalink ?? undefined };
  }
  await updatePublicationForActiveClaim(
    claim,
    { facebookPublishStatus: "pending", facebookPublishError: null },
    db,
  );

  try {
    const postId = await publishPageVideo({
      pageId: attempt.authorizedFacebookPageId,
      videoUrl: videoAssetUrl,
      caption: attempt.authorizedCaption,
    });
    await updatePublicationForActiveClaim(
      claim,
      {
        facebookPublishStatus: "published",
        facebookPostId: postId,
        facebookPublishedAt: new Date(),
        facebookPublishError: null,
      },
      db,
    );
    const permalink = await getVideoPermalink(postId);
    if (permalink) {
      try {
        await updatePublicationForActiveClaim(claim, { facebookPermalink: permalink }, db);
      } catch {
        // Published id/status is already durable.
      }
    }
    return { status: "published", permalink };
  } catch (error) {
    const ambiguous = isAmbiguousPostError(error);
    await updatePublicationForActiveClaim(
      claim,
      {
        facebookPublishStatus: ambiguous ? "manual_review" : "failed",
        facebookPublishError: safeFailure(error),
      },
      db,
    );
    return { status: ambiguous ? "manual_review" : "failed", error: safeFailure(error) };
  }
}

function resultFromStoredStatus(
  status: PlatformPublishStatus,
  permalink?: string | null,
): PublishPlatformResult {
  if (status === "published") return { status: "skipped", permalink: permalink ?? undefined };
  if (status === "manual_review") {
    return { status: "manual_review", error: "Publication needs manual review." };
  }
  if (status === "failed") return { status: "failed", error: "Publication failed." };
  return { status: "skipped" };
}

async function finalizeClaim(
  claim: AttemptClaim,
  outcome: "completed" | "failed" | "manual_review",
  error: string | null,
  db: Db,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [finalized] = await tx
      .update(publicationAttempts)
      .set({
        status: outcome,
        error,
        lockedUntil: null,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(publicationAttempts.id, claim.attemptId),
          eq(publicationAttempts.clipId, claim.clipId),
          eq(publicationAttempts.publicationId, claim.publicationId),
          eq(publicationAttempts.claimToken, claim.claimToken),
          eq(publicationAttempts.status, "processing"),
          sql`${publicationAttempts.lockedUntil} > now()`,
        ),
      )
      .returning({ clipId: publicationAttempts.clipId });
    if (!finalized) throw new PublishClaimError("This publish claim expired before finalization.");
    if (outcome === "completed") {
      await tx
        .update(clips)
        .set({ status: "published", publishedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(clips.id, finalized.clipId), eq(clips.status, "approved")));
    }
  });
}

/** Sole Meta-delivery path for both immediate and scheduled authorizations. */
export async function publishClaimedClip(
  claim: AttemptClaim,
  options: PublishingRuntimeOptions = {},
): Promise<PublishCoreResult> {
  const db = runtimeDb(options);
  const context = await loadActiveClaim(claim, db);
  const targets = runtimeTargets(options);
  const authorization = resolveAuthorizedPublishContext(
    {
      status: context.clip.status,
      authorizedAt: context.attempt.authorizedAt,
      proposedCaption: context.clip.proposedCaption,
      authorizedCaption: context.attempt.authorizedCaption,
      authorizedInstagramUserId: context.attempt.authorizedInstagramUserId,
      authorizedFacebookPageId: context.attempt.authorizedFacebookPageId,
    },
    targets,
  );
  if (!authorization.ok) {
    await markActiveClaimForManualReview(
      claim,
      authorization.reason === "targets_changed"
        ? "The configured publishing destinations changed after authorization."
        : "The persisted publish authorization is incomplete.",
      { db },
    );
    throw new PublishClaimError(
      authorization.reason === "targets_changed"
        ? "Publishing destinations changed after authorization."
        : "The publish authorization is incomplete.",
    );
  }

  let videoAssetUrl: string;
  try {
    videoAssetUrl = await acquireVideoAsset(claim, context, db);
  } catch (error) {
    await updateActiveAttempt(
      claim,
      {
        status: "failed",
        error: "Could not acquire the clip video.",
        lockedUntil: null,
        completedAt: new Date(),
      },
      db,
    );
    throw error;
  }

  let current = await loadActiveClaim(claim, db);
  const instagram = await attemptInstagramPublish(claim, current, videoAssetUrl, db);
  current = await loadActiveClaim(claim, db);
  const facebook = await attemptFacebookPublish(claim, current, videoAssetUrl, db);
  current = await loadActiveClaim(claim, db);

  const outcome = resolveScheduleOutcome(
    current.publication.instagramPublishStatus,
    current.publication.facebookPublishStatus,
  );
  const allPublished = outcome === "completed";
  const error =
    outcome === "manual_review"
      ? "At least one platform outcome needs manual review before any retry."
      : outcome === "failed"
        ? "At least one platform did not publish."
        : null;
  await finalizeClaim(claim, outcome, error, db);

  return {
    instagram:
      instagram.status === "skipped"
        ? resultFromStoredStatus(
            current.publication.instagramPublishStatus,
            current.publication.instagramPermalink,
          )
        : instagram,
    facebook:
      facebook.status === "skipped"
        ? resultFromStoredStatus(
            current.publication.facebookPublishStatus,
            current.publication.facebookPermalink,
          )
        : facebook,
    allPublished,
    scheduleStatus: outcome,
  };
}
