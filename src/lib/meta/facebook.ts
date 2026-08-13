import { metaGraphFetch } from "./client";
import type { FacebookVideoPermalinkResponse, FacebookVideoPublishResponse } from "./types";

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
  return res.id;
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
    const res = await metaGraphFetch<FacebookVideoPermalinkResponse>(`/${videoId}`, {
      params: { fields: "permalink_url" },
    });
    return res.permalink_url;
  } catch {
    return undefined;
  }
}
