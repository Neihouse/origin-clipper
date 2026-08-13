import { put } from "@vercel/blob";
import { config } from "@/lib/config";

export interface RehostedVideo {
  url: string;
  size: number;
  contentType: string;
}

/**
 * Downloads a source video (typically the short-lived signed URL returned by
 * `fetchClipSourceVideoUrl`) and re-hosts it on Vercel Blob at a deterministic
 * pathname (e.g. `clips/${twitchClipId}.mp4`), so a retry after a downstream
 * (Meta-side) failure overwrites the same asset instead of accumulating
 * orphaned blobs.
 *
 * Validates both `res.ok` and a `video/*` content-type before treating the
 * fetch as successful — an expired or invalid signed URL commonly comes back
 * as a 200 with an HTML access-denied/error page, which would otherwise
 * silently get "successfully" re-hosted as a broken, unplayable video.
 *
 * Clips are short (≤60s), so the whole body is buffered in memory and
 * uploaded in a single `put()` call rather than streamed.
 */
export async function rehostClipVideo(
  sourceUrl: string,
  pathname: string,
): Promise<RehostedVideo> {
  const res = await fetch(sourceUrl);

  if (!res.ok) {
    throw new Error(`Failed to fetch source video: ${res.status} ${res.statusText}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.startsWith("video/")) {
    throw new Error(
      `Source video fetch did not return a video: content-type was "${contentType || "(missing)"}"`,
    );
  }

  const buffer = Buffer.from(await res.arrayBuffer());

  const blob = await put(pathname, buffer, {
    access: "public",
    contentType: "video/mp4",
    addRandomSuffix: false,
    // Deterministic pathnames are the point (see doc comment above) — a
    // retry must be able to overwrite the previous attempt's blob rather
    // than erroring because it already exists.
    allowOverwrite: true,
    token: config.blob.readWriteToken,
  });

  return {
    url: blob.url,
    size: buffer.byteLength,
    contentType: blob.contentType,
  };
}
