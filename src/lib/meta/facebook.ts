import { metaGraphFetch } from "./client";
import type { FacebookVideoPermalinkResponse, FacebookVideoPublishResponse } from "./types";

function requireGraphId(value: unknown, operation: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${operation} returned no usable id`);
  }
  return value;
}

function safeFacebookPermalink(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      !(host === "facebook.com" || host.endsWith(".facebook.com") || host === "fb.watch")
    ) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

// Endpoint choice, flagged for implementation-time verification:
//
// This uses POST /{page-id}/videos, Meta's long-standing Page video
// publishing endpoint. It accepts `file_url` for a single-call, non-chunked
// publish (fine for ORIGIN's short clips) and is stable/well-documented.
//
// Meta also has POST /{page-id}/video_reels, a dedicated Reels-surface
// endpoint — but its documented flow is a phased resumable upload
// (upload_phase=start/transfer/finish) rather than a single file_url call.
// If this pipeline later needs a guarantee that FB posts land on the Reels
// surface specifically (vs. a plain feed/video-tab post via /videos), that
// needs to be re-confirmed against Meta's *live* Graph API docs before
// switching endpoints — don't assume based on this comment, Meta has changed
// this endpoint's shape before.
function publishPath(pageId: string): string {
  return `/${pageId}/videos`;
}

export interface PublishPageVideoInput {
  pageId: string;
  videoUrl: string;
  caption: string;
}

/**
 * Publishes a hosted video to a Facebook Page via POST /{page-id}/videos
 * with the `file_url` parameter (Meta fetches the video from that URL
 * server-side — no binary upload from this app). Returns the resulting FB
 * video id.
 */
export async function publishPageVideo({
  pageId,
  videoUrl,
  caption,
}: PublishPageVideoInput): Promise<string> {
  const res = await metaGraphFetch<FacebookVideoPublishResponse>(publishPath(pageId), {
    method: "POST",
    params: { file_url: videoUrl, description: caption },
  });
  return requireGraphId(res?.id, "Facebook video publish");
}

/**
 * Best-effort permalink lookup (GET /{video-id}?fields=permalink_url).
 * Never throws — this runs after the video is already posted, so a lookup
 * failure here must not be allowed to fail an already-successful publish.
 * Callers that get `undefined` back should just leave the stored permalink
 * null.
 */
export async function getVideoPermalink(videoId: string): Promise<string | undefined> {
  try {
    return (await readPublishedVideo(videoId)).permalink;
  } catch {
    return undefined;
  }
}

/**
 * Strict read-back for an operator resolving an ambiguous publish. The Graph
 * response, rather than a typed permalink, is the source of truth.
 */
async function readPublishedVideo(
  videoId: string,
): Promise<{ permalink: string; pageId: string | null }> {
  const res = await metaGraphFetch<FacebookVideoPermalinkResponse>(`/${videoId}`, {
    params: { fields: "id,from,permalink_url" },
  });
  const returnedId = requireGraphId(res?.id, "Facebook video verification");
  if (returnedId !== videoId) {
    throw new Error("Facebook video verification returned a different id");
  }
  const permalink = safeFacebookPermalink(res?.permalink_url);
  if (!permalink) {
    throw new Error("Facebook video verification returned no safe permalink");
  }
  return {
    permalink,
    pageId: typeof res?.from?.id === "string" ? res.from.id : null,
  };
}

export async function verifyPublishedVideo(
  videoId: string,
  expectedPageId: string,
): Promise<string> {
  const video = await readPublishedVideo(videoId);
  if (!video.pageId || video.pageId !== expectedPageId) {
    throw new Error("Facebook video verification returned a different Page owner");
  }
  return video.permalink;
}
