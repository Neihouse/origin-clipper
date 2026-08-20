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
