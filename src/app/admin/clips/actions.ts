"use server";

import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { clips, type Clip, type NewClip } from "@/db/schema";
import { requireSession } from "@/lib/auth/require-session";
import { runWeeklyCollection, type CollectionSummary } from "@/lib/collection/run";
import { config } from "@/lib/config";
import { fetchClipSourceVideoUrl } from "@/lib/twitch/unofficial-clip-video";
import { rehostClipVideo } from "@/lib/media/rehost-clip-video";
import { publishReel } from "@/lib/meta/instagram";
import { publishPageVideo, getVideoPermalink } from "@/lib/meta/facebook";

function requireId(formData: FormData): string {
  const id = formData.get("id");
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("Missing clip id.");
  }
  return id;
}

export async function approveClip(formData: FormData): Promise<void> {
  await requireSession();
  const id = requireId(formData);

  const db = getDb();
  await db
    .update(clips)
    .set({ status: "approved", approvedAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(clips.id, id));

  revalidatePath("/admin/clips");
}

export async function rejectClip(formData: FormData): Promise<void> {
  await requireSession();
  const id = requireId(formData);

  const db = getDb();
  await db
    .update(clips)
    .set({ status: "rejected", updatedAt: sql`now()` })
    .where(eq(clips.id, id));

  revalidatePath("/admin/clips");
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
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      status: "error",
      message: "Collection failed. Check the server logs for details.",
    };
  }
}

export interface PublishPlatformResult {
  status: "skipped" | "published" | "failed";
  permalink?: string;
  error?: string;
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

/**
 * Publishes (or resumes publishing) a clip to Instagram Reels. A no-op if
 * this platform already succeeded on a prior attempt, so re-clicking Publish
 * after a partial failure never double-posts. Never throws — any failure is
 * captured in the returned result/update so it can't block the other
 * platform's attempt in Promise.all.
 */
async function attemptInstagramPublish(
  clip: Clip,
  videoAssetUrl: string,
  caption: string,
): Promise<{ update: Partial<NewClip>; result: PublishPlatformResult }> {
  if (clip.instagramPublishStatus === "published") {
    return {
      update: {},
      result: { status: "skipped", permalink: clip.instagramPermalink ?? undefined },
    };
  }

  try {
    const { containerId, mediaId, permalink } = await publishReel({
      igUserId: config.meta.igUserId,
      videoUrl: videoAssetUrl,
      caption,
      existingContainerId: clip.instagramContainerId ?? undefined,
    });

    return {
      update: {
        instagramPublishStatus: "published",
        instagramContainerId: containerId,
        instagramMediaId: mediaId,
        instagramPermalink: permalink ?? null,
        instagramPublishedAt: new Date(),
        instagramPublishError: null,
      },
      result: { status: "published", permalink },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      update: { instagramPublishStatus: "failed", instagramPublishError: message },
      result: { status: "failed", error: message },
    };
  }
}

/**
 * Publishes (or resumes publishing) a clip to the Facebook Page. Same
 * idempotent-skip / never-throws contract as attemptInstagramPublish.
 */
async function attemptFacebookPublish(
  clip: Clip,
  videoAssetUrl: string,
  caption: string,
): Promise<{ update: Partial<NewClip>; result: PublishPlatformResult }> {
  if (clip.facebookPublishStatus === "published") {
    return {
      update: {},
      result: { status: "skipped", permalink: clip.facebookPermalink ?? undefined },
    };
  }

  try {
    const postId = await publishPageVideo({
      pageId: config.meta.pageId,
      videoUrl: videoAssetUrl,
      caption,
    });
    const permalink = await getVideoPermalink(postId);

    return {
      update: {
        facebookPublishStatus: "published",
        facebookPostId: postId,
        facebookPermalink: permalink ?? null,
        facebookPublishedAt: new Date(),
        facebookPublishError: null,
      },
      result: { status: "published", permalink },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      update: { facebookPublishStatus: "failed", facebookPublishError: message },
      result: { status: "failed", error: message },
    };
  }
}

/**
 * Publishes an approved clip to Instagram Reels + the Facebook Page.
 *
 * - Re-validates `status === "approved"` server-side — never trust the
 *   client's disabled button state.
 * - Reuses `clip.videoAssetUrl` if a prior attempt already rehosted it, so a
 *   retry after a Meta-side failure never re-triggers the unofficial Twitch
 *   video-acquisition step.
 * - Attempts Instagram and Facebook independently (Promise.all over two
 *   never-throwing helpers) so one platform's failure never blocks the
 *   other, and skips any platform already `"published"` so retries are safe.
 * - Reads `clip.proposedCaption` as already stored — never regenerates it,
 *   since that could silently change text the human already approved.
 * - Flips `status: "published"` + `publishedAt` only once both platforms
 *   report `"published"`.
 */
export async function publishClip(
  prevState: PublishActionState,
  formData: FormData,
): Promise<PublishActionState> {
  await requireSession();

  try {
    const id = requireId(formData);
    const db = getDb();

    const [clip] = await db.select().from(clips).where(eq(clips.id, id)).limit(1);
    if (!clip) {
      return { status: "error", message: "Clip not found." };
    }
    if (clip.status !== "approved") {
      return { status: "error", message: "Clip must be approved before it can be published." };
    }
    if (!clip.proposedCaption) {
      return { status: "error", message: "Clip has no proposed caption to publish." };
    }

    await db
      .update(clips)
      .set({ publishAttemptedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(clips.id, id));

    let videoAssetUrl = clip.videoAssetUrl;
    if (!videoAssetUrl) {
      try {
        const source = await fetchClipSourceVideoUrl(clip.twitchClipId);
        const rehosted = await rehostClipVideo(source.videoUrl, `clips/${clip.twitchClipId}.mp4`);
        videoAssetUrl = rehosted.url;
        await db
          .update(clips)
          .set({
            videoAssetUrl,
            videoAssetFetchedAt: sql`now()`,
            videoAssetError: null,
            updatedAt: sql`now()`,
          })
          .where(eq(clips.id, id));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await db
          .update(clips)
          .set({ videoAssetError: message, updatedAt: sql`now()` })
          .where(eq(clips.id, id));
        revalidatePath("/admin/clips");
        return { status: "error", message: `Could not acquire the clip's video: ${message}` };
      }
    }

    if (!videoAssetUrl) {
      return { status: "error", message: "Video asset URL unexpectedly missing." };
    }

    const caption = clip.proposedCaption;

    const [instagram, facebook] = await Promise.all([
      attemptInstagramPublish(clip, videoAssetUrl, caption),
      attemptFacebookPublish(clip, videoAssetUrl, caption),
    ]);

    const nextInstagramStatus = instagram.update.instagramPublishStatus ?? clip.instagramPublishStatus;
    const nextFacebookStatus = facebook.update.facebookPublishStatus ?? clip.facebookPublishStatus;
    const allPublished = nextInstagramStatus === "published" && nextFacebookStatus === "published";

    await db
      .update(clips)
      .set({
        ...instagram.update,
        ...facebook.update,
        ...(allPublished ? { status: "published" as const, publishedAt: sql`now()` } : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(clips.id, id));

    revalidatePath("/admin/clips");

    return {
      status: "ok",
      instagram: instagram.result,
      facebook: facebook.result,
      allPublished,
    };
  } catch (error) {
    console.error("Clip publish failed:", {
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Publish failed. Check the server logs for details.",
    };
  }
}
