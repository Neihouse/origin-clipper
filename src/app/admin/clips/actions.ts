"use server";

import { revalidatePath } from "next/cache";
import { and, eq, exists, inArray, isNull, notExists, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  clipPublications,
  clips,
  instagramCollaborationStatusEnum,
  publicationAttempts,
  type InstagramCollaborationStatus,
} from "@/db/schema";
import { requireSession } from "@/lib/auth/require-session";
import { runWeeklyCollection, type CollectionSummary } from "@/lib/collection/run";
import { verifyPublishedVideo } from "@/lib/meta/facebook";
import { verifyPublishedMedia } from "@/lib/meta/instagram";
import {
  claimImmediatePublish,
  markActiveClaimForManualReview,
  publishClaimedClip,
  type PublishPlatformResult,
} from "@/lib/publishing/core";
import { validateScheduleTime } from "@/lib/publishing/policy";
import { getPublishingStateForClip } from "@/lib/publishing/queries";
import {
  authorizeScheduledPublish,
  cancelScheduledAttempt,
  findActiveAttemptForClip,
  rescheduleScheduledAttempt,
} from "@/lib/publishing/repository";

export type { PublishPlatformResult } from "@/lib/publishing/core";

const ACTIVE_ATTEMPT_STATUSES = ["scheduled", "processing", "manual_review"] as const;

function requireString(formData: FormData, name: string): string {
  const value = formData.get(name);
  if (typeof value !== "string" || value.length === 0) throw new Error(`Missing ${name}.`);
  return value;
}

function optionalString(formData: FormData, name: string): string | null {
  const value = formData.get(name);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function requireId(formData: FormData): string {
  return requireString(formData, "id");
}

function revalidateClip(id: string): void {
  revalidatePath("/admin/clips");
  revalidatePath(`/admin/clips/${id}`);
}

function noActiveAttemptForClip(id: string) {
  const db = getDb();
  return notExists(
    db
      .select({ one: sql`1` })
      .from(publicationAttempts)
      .where(
        and(
          eq(publicationAttempts.clipId, id),
          inArray(publicationAttempts.status, ACTIVE_ATTEMPT_STATUSES),
        ),
      ),
  );
}

export async function approveClip(formData: FormData): Promise<void> {
  await requireSession();
  const id = requireId(formData);
  const db = getDb();
  const [approved] = await db
    .update(clips)
    .set({ status: "approved", approvedAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(clips.id, id),
        inArray(clips.status, ["discovered", "shortlisted"]),
        noActiveAttemptForClip(id),
      ),
    )
    .returning({ id: clips.id });
  if (!approved) throw new Error("This clip can no longer be approved from its current state.");
  revalidateClip(id);
}

export async function rejectClip(formData: FormData): Promise<void> {
  await requireSession();
  const id = requireId(formData);
  const db = getDb();
  const [rejected] = await db
    .update(clips)
    .set({ status: "rejected", updatedAt: sql`now()` })
    .where(
      and(
        eq(clips.id, id),
        inArray(clips.status, ["discovered", "shortlisted"]),
        noActiveAttemptForClip(id),
      ),
    )
    .returning({ id: clips.id });
  if (!rejected) throw new Error("This clip can no longer be rejected from its current state.");
  revalidateClip(id);
}

export type NotesActionState =
  | { status: "idle" }
  | { status: "ok" }
  | { status: "error"; message: string };

export async function updateClipNotes(
  prevState: NotesActionState,
  formData: FormData,
): Promise<NotesActionState> {
  await requireSession();
  try {
    const id = requireId(formData);
    const notes = formData.get("notes");
    await getDb()
      .update(clips)
      .set({
        notes: typeof notes === "string" && notes.length > 0 ? notes : null,
        updatedAt: sql`now()`,
      })
      .where(eq(clips.id, id));
    revalidatePath(`/admin/clips/${id}`);
    return { status: "ok" };
  } catch (error) {
    console.error("Clip notes update failed:", {
      name: error instanceof Error ? error.name : typeof error,
    });
    return { status: "error", message: "Could not save notes." };
  }
}

export type CollectionActionState =
  | { status: "idle" }
  | { status: "ok"; summary: CollectionSummary }
  | { status: "error"; message: string };

export async function runCollectionNow(): Promise<CollectionActionState> {
  await requireSession();
  try {
    const summary = await runWeeklyCollection();
    revalidatePath("/admin/clips");
    return { status: "ok", summary };
  } catch (error) {
    console.error("Manual clip collection failed:", {
      name: error instanceof Error ? error.name : typeof error,
    });
    return { status: "error", message: "Collection failed. Check the server logs for details." };
  }
}

export type PublishActionState =
  | { status: "idle" }
  | {
      status: "ok";
      instagram: PublishPlatformResult;
      facebook: PublishPlatformResult;
      allPublished: boolean;
    }
  | { status: "error"; message: string };

/** Authenticated immediate authorization; the core is shared with the due worker. */
export async function publishClip(
  prevState: PublishActionState,
  formData: FormData,
): Promise<PublishActionState> {
  await requireSession();
  let claim: Awaited<ReturnType<typeof claimImmediatePublish>> = null;
  try {
    const id = requireId(formData);
    claim = await claimImmediatePublish(id);
    if (!claim) {
      return {
        status: "error",
        message:
          "This approved clip cannot publish now. Cancel any active schedule or resolve its review state first.",
      };
    }
    const result = await publishClaimedClip(claim);
    revalidateClip(id);
    return {
      status: "ok",
      instagram: result.instagram,
      facebook: result.facebook,
      allPublished: result.allPublished,
    };
  } catch (error) {
    if (claim) await markActiveClaimForManualReview(claim);
    console.error("Clip publish failed:", {
      clipId: claim?.clipId,
      name: error instanceof Error ? error.name : typeof error,
    });
    if (claim) revalidateClip(claim.clipId);
    return {
      status: "error",
      message: "Publish stopped safely. Review the clip status before trying again.",
    };
  }
}

export type ClipWorkflowActionState =
  | { status: "idle" }
  | { status: "ok"; message: string }
  | { status: "error"; message: string };

function validateScheduleForm(formData: FormData) {
  return validateScheduleTime({
    scheduledFor: requireString(formData, "scheduledFor"),
    scheduledForLocal: requireString(formData, "scheduledForLocal"),
    timeZone: requireString(formData, "timeZone"),
  });
}

export async function scheduleClip(
  prevState: ClipWorkflowActionState,
  formData: FormData,
): Promise<ClipWorkflowActionState> {
  await requireSession();
  try {
    const id = requireId(formData);
    const validation = validateScheduleForm(formData);
    if (!validation.ok) return { status: "error", message: validation.message };
    const attempt = await authorizeScheduledPublish(id, validation.scheduledFor);
    if (!attempt) {
      return {
        status: "error",
        message: "Only an approved clip without an active authorization can be scheduled.",
      };
    }
    revalidateClip(id);
    return { status: "ok", message: "Publish scheduled." };
  } catch (error) {
    console.error("Clip schedule creation failed:", {
      name: error instanceof Error ? error.name : typeof error,
    });
    return { status: "error", message: "Could not save the publish schedule." };
  }
}

export async function rescheduleClip(
  prevState: ClipWorkflowActionState,
  formData: FormData,
): Promise<ClipWorkflowActionState> {
  await requireSession();
  try {
    const id = requireId(formData);
    const validation = validateScheduleForm(formData);
    if (!validation.ok) return { status: "error", message: validation.message };
    const db = getDb();
    const activeAttempt = await findActiveAttemptForClip(id, { db });
    let replacement = null;
    if (activeAttempt?.status === "scheduled") {
      replacement = await rescheduleScheduledAttempt(activeAttempt.id, validation.scheduledFor, {
        db,
      });
    } else if (!activeAttempt) {
      const state = await getPublishingStateForClip(id, db);
      if (state.scheduleStatus === "failed") {
        replacement = await authorizeScheduledPublish(id, validation.scheduledFor, { db });
      }
    }
    if (!replacement) {
      return {
        status: "error",
        message: "This schedule can no longer be changed; it may already be processing.",
      };
    }
    revalidateClip(id);
    return { status: "ok", message: "Publish rescheduled." };
  } catch (error) {
    console.error("Clip schedule replacement failed:", {
      name: error instanceof Error ? error.name : typeof error,
    });
    return { status: "error", message: "Could not save the publish schedule." };
  }
}

export async function cancelScheduledPublish(
  prevState: ClipWorkflowActionState,
  formData: FormData,
): Promise<ClipWorkflowActionState> {
  await requireSession();
  try {
    const id = requireId(formData);
    const db = getDb();
    const activeAttempt = await findActiveAttemptForClip(id, { db });
    const cancelled =
      activeAttempt?.status === "scheduled"
        ? await cancelScheduledAttempt(activeAttempt.id, { db })
        : false;
    if (!cancelled) {
      return {
        status: "error",
        message: "This schedule is already processing or is no longer cancellable.",
      };
    }
    revalidateClip(id);
    return { status: "ok", message: "Scheduled publish cancelled." };
  } catch (error) {
    console.error("Scheduled publish cancellation failed:", {
      name: error instanceof Error ? error.name : typeof error,
    });
    return { status: "error", message: "Could not cancel the scheduled publish." };
  }
}

export async function updateInstagramCollaboration(
  prevState: ClipWorkflowActionState,
  formData: FormData,
): Promise<ClipWorkflowActionState> {
  await requireSession();
  try {
    const id = requireId(formData);
    const rawStatus = requireString(formData, "collaborationStatus");
    if (!(instagramCollaborationStatusEnum.enumValues as readonly string[]).includes(rawStatus)) {
      return { status: "error", message: "Choose a valid collaboration status." };
    }
    const collaborationStatus = rawStatus as InstagramCollaborationStatus;
    if (collaborationStatus === "not_requested") {
      return { status: "error", message: "Collaboration status only moves forward." };
    }
    const [updated] = await getDb()
      .update(clipPublications)
      .set({
        instagramCollaborationStatus: collaborationStatus,
        instagramCollaborationUpdatedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(clipPublications.clipId, id),
          eq(clipPublications.instagramPublishStatus, "published"),
          eq(
            clipPublications.instagramCollaborationStatus,
            collaborationStatus === "pending" ? "not_requested" : "pending",
          ),
        ),
      )
      .returning({ id: clipPublications.id });
    if (!updated) {
      return {
        status: "error",
        message: "Publish to Instagram before updating its collaboration status.",
      };
    }
    revalidateClip(id);
    return { status: "ok", message: "Instagram collaboration status updated." };
  } catch (error) {
    console.error("Instagram collaboration update failed:", {
      name: error instanceof Error ? error.name : typeof error,
    });
    return { status: "error", message: "Could not update the collaboration status." };
  }
}

export async function verifyPublishedClip(
  prevState: ClipWorkflowActionState,
  formData: FormData,
): Promise<ClipWorkflowActionState> {
  await requireSession();
  try {
    const id = requireId(formData);
    const [verified] = await getDb()
      .update(clipPublications)
      .set({ publishVerifiedAt: sql`now()`, updatedAt: sql`now()` })
      .where(
        and(
          eq(clipPublications.clipId, id),
          eq(clipPublications.instagramPublishStatus, "published"),
          eq(clipPublications.facebookPublishStatus, "published"),
          isNull(clipPublications.publishVerifiedAt),
        ),
      )
      .returning({ id: clipPublications.id });
    if (!verified) {
      return { status: "error", message: "Verify only after both platform posts are published." };
    }
    revalidateClip(id);
    return { status: "ok", message: "Both live posts marked verified." };
  } catch (error) {
    console.error("Publish verification update failed:", {
      name: error instanceof Error ? error.name : typeof error,
    });
    return { status: "error", message: "Could not save publish verification." };
  }
}

type ManualReviewPlatform = "instagram" | "facebook";
type ManualReviewResolution = "published" | "retryable_failed";

function isNumericGraphId(value: string): boolean {
  return /^\d{1,100}$/.test(value);
}

/** Resolves an ambiguous POST only after Meta confirms the operator-supplied numeric id. */
export async function resolvePlatformPublishReview(
  prevState: ClipWorkflowActionState,
  formData: FormData,
): Promise<ClipWorkflowActionState> {
  await requireSession();
  try {
    const id = requireId(formData);
    const platform = requireString(formData, "platform") as ManualReviewPlatform;
    const resolution = requireString(formData, "resolution") as ManualReviewResolution;
    if (platform !== "instagram" && platform !== "facebook") {
      return { status: "error", message: "Choose Instagram or Facebook." };
    }
    if (resolution !== "published" && resolution !== "retryable_failed") {
      return { status: "error", message: "Choose a valid review result." };
    }

    const externalId = optionalString(formData, "externalId");
    if (resolution === "published" && (!externalId || !isNumericGraphId(externalId))) {
      return { status: "error", message: "Enter the confirmed numeric platform post ID." };
    }

    const db = getDb();
    const activeAttempt = await findActiveAttemptForClip(id, { db });
    if (!activeAttempt || activeAttempt.status !== "manual_review") {
      return { status: "error", message: "This platform is no longer awaiting manual review." };
    }

    let verifiedPermalink: string | null = null;
    if (resolution === "published") {
      try {
        verifiedPermalink =
          platform === "instagram"
            ? await verifyPublishedMedia(
                externalId!,
                activeAttempt.authorizedInstagramUserId,
              )
            : await verifyPublishedVideo(
                externalId!,
                activeAttempt.authorizedFacebookPageId,
              );
      } catch (error) {
        console.error("Meta manual-review verification failed:", {
          platform,
          name: error instanceof Error ? error.name : typeof error,
        });
        return {
          status: "error",
          message: `Meta could not verify that ${platform === "instagram" ? "Instagram" : "Facebook"} post. The review state was not changed.`,
        };
      }
    }

    const result = await db.transaction(async (tx) => {
      const platformColumn =
        platform === "instagram"
          ? clipPublications.instagramPublishStatus
          : clipPublications.facebookPublishStatus;
      const [reviewed] = await tx
        .update(clipPublications)
        .set(
          platform === "instagram"
            ? {
                instagramPublishStatus: resolution === "published" ? "published" : "failed",
                instagramContainerId: resolution === "published" ? undefined : null,
                instagramMediaId: resolution === "published" ? externalId : null,
                instagramPermalink: resolution === "published" ? verifiedPermalink : null,
                instagramPublishedAt: resolution === "published" ? sql`now()` : null,
                instagramPublishError:
                  resolution === "published" ? null : "Manually inspected and cleared for retry.",
                updatedAt: sql`now()`,
              }
            : {
                facebookPublishStatus: resolution === "published" ? "published" : "failed",
                facebookPostId: resolution === "published" ? externalId : null,
                facebookPermalink: resolution === "published" ? verifiedPermalink : null,
                facebookPublishedAt: resolution === "published" ? sql`now()` : null,
                facebookPublishError:
                  resolution === "published" ? null : "Manually inspected and cleared for retry.",
                updatedAt: sql`now()`,
              },
        )
        .where(
          and(
            eq(clipPublications.id, activeAttempt.publicationId),
            eq(clipPublications.clipId, id),
            inArray(platformColumn, ["pending", "manual_review"]),
            exists(
              tx
                .select({ one: sql`1` })
                .from(publicationAttempts)
                .where(
                  and(
                    eq(publicationAttempts.id, activeAttempt.id),
                    eq(publicationAttempts.clipId, id),
                    eq(publicationAttempts.publicationId, activeAttempt.publicationId),
                    eq(publicationAttempts.status, "manual_review"),
                  ),
                ),
            ),
          ),
        )
        .returning({ id: clipPublications.id });
      if (!reviewed) return null;

      const [publication] = await tx
        .select()
        .from(clipPublications)
        .where(eq(clipPublications.id, activeAttempt.publicationId))
        .limit(1);
      if (!publication) return null;
      const bothPublished =
        publication.instagramPublishStatus === "published" &&
        publication.facebookPublishStatus === "published";
      const stillNeedsReview =
        publication.instagramPublishStatus === "manual_review" ||
        publication.instagramPublishStatus === "pending" ||
        publication.facebookPublishStatus === "manual_review" ||
        publication.facebookPublishStatus === "pending";
      const nextStatus = bothPublished
        ? "completed"
        : stillNeedsReview
          ? "manual_review"
          : "failed";
      const [attemptUpdated] = await tx
        .update(publicationAttempts)
        .set({
          status: nextStatus,
          error: stillNeedsReview
            ? "At least one platform outcome still needs manual review."
            : bothPublished
              ? null
              : "The inspected attempt is safe for a new explicit authorization.",
          lockedUntil: null,
          completedAt: stillNeedsReview ? activeAttempt.completedAt : sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(publicationAttempts.id, activeAttempt.id),
            eq(publicationAttempts.clipId, id),
            eq(publicationAttempts.publicationId, activeAttempt.publicationId),
            eq(publicationAttempts.status, "manual_review"),
          ),
        )
        .returning({ id: publicationAttempts.id });
      if (!attemptUpdated) throw new Error("MANUAL_REVIEW_RACE");
      if (bothPublished) {
        await tx
          .update(clips)
          .set({ status: "published", publishedAt: sql`now()`, updatedAt: sql`now()` })
          .where(and(eq(clips.id, id), eq(clips.status, "approved")));
      }
      return { bothPublished };
    });

    if (!result) {
      return { status: "error", message: "This platform is no longer awaiting manual review." };
    }
    revalidateClip(id);
    return {
      status: "ok",
      message: result.bothPublished
        ? "Manual review recorded; both posts are now confirmed."
        : "Manual review recorded.",
    };
  } catch (error) {
    console.error("Platform publish review resolution failed:", {
      name: error instanceof Error ? error.name : typeof error,
    });
    return { status: "error", message: "Could not save the manual review result." };
  }
}

/** Resolves schedule-level quarantine without rewriting authorization history. */
export async function resolveSchedulePublishReview(
  prevState: ClipWorkflowActionState,
  formData: FormData,
): Promise<ClipWorkflowActionState> {
  await requireSession();
  try {
    const id = requireId(formData);
    const resolution = requireString(formData, "resolution");
    if (resolution !== "cancelled" && resolution !== "retryable_failed") {
      return { status: "error", message: "Choose cancel or clear for a new authorization." };
    }
    const nextStatus = resolution === "cancelled" ? "cancelled" : "failed";
    const db = getDb();
    const activeAttempt = await findActiveAttemptForClip(id, { db });
    if (!activeAttempt || activeAttempt.status !== "manual_review") {
      return { status: "error", message: "This publish authorization is no longer in review." };
    }
    const [resolved] = await db
      .update(publicationAttempts)
      .set({
        status: nextStatus,
        error:
          resolution === "cancelled"
            ? null
            : "Manually inspected and cleared for a new explicit authorization.",
        lockedUntil: null,
        completedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(publicationAttempts.id, activeAttempt.id),
          eq(publicationAttempts.clipId, id),
          eq(publicationAttempts.publicationId, activeAttempt.publicationId),
          eq(publicationAttempts.status, "manual_review"),
          notExists(
            db
              .select({ one: sql`1` })
              .from(clipPublications)
              .where(
                and(
                  eq(clipPublications.id, activeAttempt.publicationId),
                  inArray(clipPublications.instagramPublishStatus, ["pending", "manual_review"]),
                ),
              ),
          ),
          notExists(
            db
              .select({ one: sql`1` })
              .from(clipPublications)
              .where(
                and(
                  eq(clipPublications.id, activeAttempt.publicationId),
                  inArray(clipPublications.facebookPublishStatus, ["pending", "manual_review"]),
                ),
              ),
          ),
        ),
      )
      .returning({ id: publicationAttempts.id });
    if (!resolved) {
      return {
        status: "error",
        message: "Resolve each ambiguous platform outcome before clearing this schedule review.",
      };
    }
    revalidateClip(id);
    return {
      status: "ok",
      message:
        resolution === "cancelled"
          ? "Publish authorization cancelled."
          : "Review cleared; a new Publish or Schedule Publish click is required.",
    };
  } catch (error) {
    console.error("Schedule publish review resolution failed:", {
      name: error instanceof Error ? error.name : typeof error,
    });
    return { status: "error", message: "Could not save the schedule review result." };
  }
}
