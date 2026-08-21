import { metaGraphFetch } from "./client";
import type {
  InstagramContainerStatusCode,
  InstagramContainerStatusResponse,
  InstagramMediaContainerResponse,
  InstagramMediaPermalinkResponse,
  InstagramMediaPublishResponse,
} from "./types";

// Container processing for a clip-length Reel is typically done in single-
// digit seconds. The elapsed deadline includes slow HTTP requests (which
// have their own 15s cap in metaGraphFetch), keeping the full polling stage
// under roughly two minutes rather than multiplying request timeouts by the
// attempt count.
const POLL_INTERVAL_MS = 3_000;
const MAX_POLL_ATTEMPTS = 30;
const POLL_START_DEADLINE_MS = 105_000;

const TERMINAL_STATUS_CODES: ReadonlySet<InstagramContainerStatusCode> = new Set([
  "FINISHED",
  "ERROR",
  "EXPIRED",
  "PUBLISHED",
]);
const ALL_STATUS_CODES: ReadonlySet<string> = new Set([
  "FINISHED",
  "ERROR",
  "EXPIRED",
  "IN_PROGRESS",
  "PUBLISHED",
]);

function requireGraphId(value: unknown, operation: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${operation} returned no usable id`);
  }
  return value;
}

function safeInstagramPermalink(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || !(host === "instagram.com" || host.endsWith(".instagram.com"))) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface CreateReelsContainerInput {
  igUserId: string;
  videoUrl: string;
  caption: string;
}

/**
 * Starts Instagram's async Reels publish flow: POST /{ig-user-id}/media with
 * media_type=REELS. Returns the container id — Instagram fetches and
 * processes `videoUrl` in the background; poll it with pollContainerStatus
 * before calling publishContainer.
 */
export async function createReelsContainer({
  igUserId,
  videoUrl,
  caption,
}: CreateReelsContainerInput): Promise<string> {
  const res = await metaGraphFetch<InstagramMediaContainerResponse>(`/${igUserId}/media`, {
    method: "POST",
    params: { media_type: "REELS", video_url: videoUrl, caption },
  });
  return requireGraphId(res?.id, "Instagram container creation");
}

/**
 * Polls GET /{container-id}?fields=status_code until it reaches a terminal
 * status (FINISHED, ERROR, EXPIRED, or the already-published PUBLISHED) or
 * MAX_POLL_ATTEMPTS is exhausted, in which case it throws — the container
 * may still finish later, but this call gives up waiting on it.
 */
export async function pollContainerStatus(
  containerId: string,
): Promise<InstagramContainerStatusCode> {
  const startedAt = Date.now();
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    if (Date.now() - startedAt >= POLL_START_DEADLINE_MS) break;
    const res = await metaGraphFetch<InstagramContainerStatusResponse>(`/${containerId}`, {
      params: { fields: "status_code" },
    });
    if (!ALL_STATUS_CODES.has(res?.status_code)) {
      throw new Error("Instagram container returned an unknown status");
    }
    if (TERMINAL_STATUS_CODES.has(res.status_code)) {
      return res.status_code;
    }
    const remainingMs = POLL_START_DEADLINE_MS - (Date.now() - startedAt);
    if (remainingMs <= 0) break;
    await sleep(Math.min(POLL_INTERVAL_MS, remainingMs));
  }
  throw new Error(
    `Instagram container ${containerId} did not finish processing before the polling deadline`,
  );
}

export interface PublishContainerInput {
  igUserId: string;
  containerId: string;
}

/**
 * POST /{ig-user-id}/media_publish — publishes a FINISHED container as a
 * live Reel. Returns the resulting IG media id.
 */
export async function publishContainer({
  igUserId,
  containerId,
}: PublishContainerInput): Promise<string> {
  const res = await metaGraphFetch<InstagramMediaPublishResponse>(`/${igUserId}/media_publish`, {
    method: "POST",
    params: { creation_id: containerId },
  });
  return requireGraphId(res?.id, "Instagram media publish");
}

/**
 * Best-effort permalink lookup (GET /{media-id}?fields=permalink). Never
 * throws — this runs after the Reel is already live, so a lookup failure
 * here must not be allowed to fail an already-successful publish. Callers
 * that get `undefined` back should just leave the stored permalink null.
 */
export async function getMediaPermalink(mediaId: string): Promise<string | undefined> {
  try {
    return (await readPublishedMedia(mediaId)).permalink;
  } catch {
    return undefined;
  }
}

/**
 * Strict read-back used by the manual-review workflow. Unlike the
 * best-effort post-publish lookup above, this rejects an inaccessible id, an
 * id mismatch, or an unsafe/missing permalink so operator-entered text alone
 * can never turn an ambiguous POST into a confirmed publication.
 */
async function readPublishedMedia(
  mediaId: string,
): Promise<{ permalink: string; ownerId: string | null }> {
  const res = await metaGraphFetch<InstagramMediaPermalinkResponse>(`/${mediaId}`, {
    params: { fields: "id,owner,permalink" },
  });
  const returnedId = requireGraphId(res?.id, "Instagram media verification");
  if (returnedId !== mediaId) {
    throw new Error("Instagram media verification returned a different id");
  }
  const permalink = safeInstagramPermalink(res?.permalink);
  if (!permalink) {
    throw new Error("Instagram media verification returned no safe permalink");
  }
  return {
    permalink,
    ownerId: typeof res?.owner?.id === "string" ? res.owner.id : null,
  };
}

export async function verifyPublishedMedia(
  mediaId: string,
  expectedIgUserId: string,
): Promise<string> {
  const media = await readPublishedMedia(mediaId);
  if (!media.ownerId || media.ownerId !== expectedIgUserId) {
    throw new Error("Instagram media verification returned a different owner");
  }
  return media.permalink;
}
