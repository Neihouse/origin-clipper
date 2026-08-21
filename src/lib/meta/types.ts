// Response shapes for the Meta Graph API calls this app makes. Only the
// fields this codebase actually reads are declared — Graph API responses
// carry more fields than this in practice, and we don't type what we don't use.

/**
 * Meta Graph API's standard error envelope. A failed call (Instagram or
 * Facebook, any endpoint) returns this shape in the response body:
 * https://developers.facebook.com/docs/graph-api/guides/error-handling
 */
export interface MetaGraphErrorResponse {
  error: {
    message: string;
    type: string;
    code: number;
    error_subcode?: number;
    fbtrace_id: string;
  };
}

// -- Instagram: POST /{ig-user-id}/media with media_type=REELS --
export interface InstagramMediaContainerResponse {
  id: string;
}

// -- Instagram: GET /{container-id}?fields=status_code --
export type InstagramContainerStatusCode =
  | "EXPIRED"
  | "ERROR"
  | "FINISHED"
  | "IN_PROGRESS"
  | "PUBLISHED";

export interface InstagramContainerStatusResponse {
  id: string;
  status_code: InstagramContainerStatusCode;
}

// -- Instagram: POST /{ig-user-id}/media_publish --
export interface InstagramMediaPublishResponse {
  id: string;
}

// -- Instagram: GET /{media-id}?fields=permalink --
export interface InstagramMediaPermalinkResponse {
  id: string;
  permalink?: string;
  owner?: { id?: string };
}

// -- Facebook: POST /{page-id}/videos with file_url --
export interface FacebookVideoPublishResponse {
  id: string;
}

// -- Facebook: GET /{video-id}?fields=permalink_url --
export interface FacebookVideoPermalinkResponse {
  id: string;
  permalink_url?: string;
  from?: { id?: string };
}

// -- Instagram: GET /{ig-media-id}/insights?metric=... --
// -- Facebook: GET /{video-id}/video_insights?metric=... --
// Meta's shared insights envelope: a list of named metrics, each carrying a
// single current value. A metric this app requested but Meta has no data
// for is simply absent from `data` — never returned with `value: 0`.
export interface MetaInsightsResponse {
  data?: Array<{
    name: string;
    values?: Array<{ value?: number }>;
  }>;
}

// -- Facebook: GET /{video-id}?fields=reactions.summary(total_count),comments.summary(total_count),shares --
export interface FacebookVideoEngagementResponse {
  id: string;
  reactions?: { summary?: { total_count?: number } };
  comments?: { summary?: { total_count?: number } };
  shares?: { count?: number };
}
