import { metaGraphFetch } from "./client";
import type {
  InstagramContainerStatusCode,
  InstagramContainerStatusResponse,
  InstagramMediaContainerResponse,
  InstagramMediaPermalinkResponse,
  InstagramMediaPublishResponse,
} from "./types";

// Container processing for a clip-length Reel is typically done in single-
// digit seconds; this bound (30 attempts * 3s = up to 90s) gives generous
// headroom without letting one publish attempt hang indefinitely.
const POLL_INTERVAL_MS = 3_000;
const MAX_POLL_ATTEMPTS = 30;

const TERMINAL_STATUS_CODES: ReadonlySet<InstagramContainerStatusCode> = new Set([
  "FINISHED",
  "ERROR",
  "EXPIRED",
  "PUBLISHED",
]);

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
  return res.id;
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
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    const res = await metaGraphFetch<InstagramContainerStatusResponse>(`/${containerId}`, {
      params: { fields: "status_code" },
    });
    if (TERMINAL_STATUS_CODES.has(res.status_code)) {
      return res.status_code;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `Instagram container ${containerId} did not finish processing after ${MAX_POLL_ATTEMPTS} polls`,
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
  return res.id;
}

/**
 * Best-effort permalink lookup (GET /{media-id}?fields=permalink). Never
 * throws — this runs after the Reel is already live, so a lookup failure
 * here must not be allowed to fail an already-successful publish. Callers
 * that get `undefined` back should just leave the stored permalink null.
 */
export async function getMediaPermalink(mediaId: string): Promise<string | undefined> {
  try {
    const res = await metaGraphFetch<InstagramMediaPermalinkResponse>(`/${mediaId}`, {
      params: { fields: "permalink" },
    });
    return res.permalink;
  } catch {
    return undefined;
  }
}

export interface PublishReelInput {
  igUserId: string;
  videoUrl: string;
  caption: string;
  /**
   * Container id from a prior attempt (e.g. stored on clips.instagramContainerId).
   * When set, container creation is skipped and this id is polled/published
   * directly — clicking Publish twice must never create a second container
   * for the same clip.
   */
  existingContainerId?: string;
}

export interface PublishReelResult {
  containerId: string;
  mediaId: string;
  permalink?: string;
}

/**
 * Orchestrates the full Reels publish flow: create-or-reuse container, poll
 * to FINISHED, publish, best-effort permalink lookup. Throws (without
 * publishing) if the container ends in ERROR or EXPIRED — callers should
 * persist the returned/thrown container id either way so a retry can decide
 * whether to reuse it or start fresh.
 *
 * Note: a reused container that comes back EXPIRED (Meta expires unpublished
 * containers after ~24h) cannot be published — this throws in that case
 * rather than silently minting a new container, since only the caller knows
 * whether "create a new one and retry" is the right response.
 */
export async function publishReel({
  igUserId,
  videoUrl,
  caption,
  existingContainerId,
}: PublishReelInput): Promise<PublishReelResult> {
  const containerId =
    existingContainerId ?? (await createReelsContainer({ igUserId, videoUrl, caption }));

  const statusCode = await pollContainerStatus(containerId);
  if (statusCode !== "FINISHED") {
    throw new Error(
      `Instagram container ${containerId} ended in status ${statusCode}, not publishable`,
    );
  }

  const mediaId = await publishContainer({ igUserId, containerId });
  const permalink = await getMediaPermalink(mediaId);

  return { containerId, mediaId, permalink };
}
