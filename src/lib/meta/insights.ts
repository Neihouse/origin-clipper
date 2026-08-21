import { metaGraphFetch } from "./client";
import type {
  FacebookVideoEngagementResponse,
  MetaInsightsResponse,
} from "./types";

export interface InstagramMediaInsights {
  views: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saved: number | null;
}

export interface FacebookVideoInsights {
  videoViews: number | null;
  reactions: number | null;
  comments: number | null;
  shares: number | null;
}

/**
 * Looks up one metric's current value out of Meta's insights envelope.
 * Returns `null` — never `0` — for a metric absent from the response, since
 * Meta omits metrics it has no data for rather than returning a zero.
 */
function metricValue(res: MetaInsightsResponse | undefined, name: string): number | null {
  const value = res?.data?.find((item) => item.name === name)?.values?.[0]?.value;
  return typeof value === "number" ? value : null;
}

/**
 * Instagram media insights (GET /{ig-media-id}/insights). Metric names
 * verified live against Meta's current docs at implementation time: `plays`
 * was renamed to `views` for Reels insights in 2024 — using the old name
 * would fail outright rather than silently under-report, so this uses
 * `views`.
 */
export async function getInstagramMediaInsights(mediaId: string): Promise<InstagramMediaInsights> {
  const res = await metaGraphFetch<MetaInsightsResponse>(`/${mediaId}/insights`, {
    params: { metric: "views,reach,likes,comments,shares,saved" },
  });
  return {
    views: metricValue(res, "views"),
    reach: metricValue(res, "reach"),
    likes: metricValue(res, "likes"),
    comments: metricValue(res, "comments"),
    shares: metricValue(res, "shares"),
    saved: metricValue(res, "saved"),
  };
}

/**
 * Facebook Page video insights, split across two Graph calls because the
 * data lives in two different places:
 *
 * - `total_video_views` is a `/video_insights` metric, verified current —
 *   the `post_video_views` name sometimes referenced for this is not a
 *   documented metric of this endpoint.
 * - Reactions/comments/shares are not `/video_insights` metrics at all;
 *   they're direct summary fields on the video object itself.
 *
 * There is no confirmed Graph field for a video-level "engaged users" count
 * as of this writing — Page-level `post_engaged_users` is a Page Insights
 * metric, not a video one. Rather than guess a metric name that could
 * either hard-fail or silently report the wrong number, this app doesn't
 * fetch it: `facebook_engaged_users` isn't a column in the insights table.
 * Add it once a real field is confirmed against live Meta docs.
 */
export async function getFacebookVideoInsights(videoId: string): Promise<FacebookVideoInsights> {
  const [insights, engagement] = await Promise.all([
    metaGraphFetch<MetaInsightsResponse>(`/${videoId}/video_insights`, {
      params: { metric: "total_video_views" },
    }),
    metaGraphFetch<FacebookVideoEngagementResponse>(`/${videoId}`, {
      params: { fields: "reactions.summary(total_count),comments.summary(total_count),shares" },
    }),
  ]);
  return {
    videoViews: metricValue(insights, "total_video_views"),
    reactions: numberOrNull(engagement?.reactions?.summary?.total_count),
    comments: numberOrNull(engagement?.comments?.summary?.total_count),
    shares: numberOrNull(engagement?.shares?.count),
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}
