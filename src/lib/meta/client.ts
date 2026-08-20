import { config } from "@/lib/config";
import type { MetaGraphErrorResponse } from "./types";

const GRAPH_API_BASE = "https://graph.facebook.com";
const META_REQUEST_TIMEOUT_MS = 15_000;

// HTTP statuses / Graph error codes known to be transient — rate limiting
// and momentary service hiccups. Everything else (bad params, permission or
// auth failures, an expired container, an invalid asset URL, etc.) is
// terminal: retrying the identical call won't help without a code or input
// change. Codes per Meta's error-handling guide:
// https://developers.facebook.com/docs/graph-api/guides/error-handling
//   1   = API Unknown (transient service error)
//   2   = API Service (temporarily unavailable)
//   4   = API Too Many Calls
//   17  = User request limit reached
//   32  = Page request limit reached
//   613 = Custom rate limit hit
const RETRYABLE_ERROR_CODES = new Set([1, 2, 4, 17, 32, 613]);

export type MetaGraphErrorClassification = "retryable" | "terminal";

function classify(httpStatus: number, code: number): MetaGraphErrorClassification {
  if (httpStatus === 429 || httpStatus >= 500) return "retryable";
  return RETRYABLE_ERROR_CODES.has(code) ? "retryable" : "terminal";
}

/**
 * Typed error for a failed Meta Graph API call. Carries what a caller needs
 * to decide whether retrying is worthwhile (`classification`) and what to
 * hand Meta support if not (`fbtraceId`).
 */
export class MetaGraphApiError extends Error {
  readonly httpStatus: number;
  readonly code: number;
  readonly errorSubcode?: number;
  readonly type: string;
  readonly fbtraceId: string;
  readonly classification: MetaGraphErrorClassification;

  constructor(httpStatus: number, body: MetaGraphErrorResponse["error"]) {
    const subcodeSuffix = body.error_subcode ? `/${body.error_subcode}` : "";
    super(`Meta Graph API error ${body.code}${subcodeSuffix}: ${body.message}`);
    this.name = "MetaGraphApiError";
    this.httpStatus = httpStatus;
    this.code = body.code;
    this.errorSubcode = body.error_subcode;
    this.type = body.type;
    this.fbtraceId = body.fbtrace_id;
    this.classification = classify(httpStatus, body.code);
  }
}

export interface MetaGraphFetchOptions {
  method?: "GET" | "POST";
  params?: Record<string, string | number | boolean | undefined>;
}

/**
 * Thin fetch wrapper for the Meta Graph API — same shape as
 * src/lib/twitch/client.ts. Prefixes the configured API version, sends the
 * Page access token via the `Authorization: Bearer` header (Graph API
 * accepts the token either as a query param or a header; the header keeps
 * it out of any URL that ends up logged or included in a thrown error), and
 * throws a typed MetaGraphApiError when the response body is Graph's
 * `{ error: {...} }` envelope.
 *
 * No token refresh path: config.meta.pageAccessToken is expected to be a
 * long-lived Page access token minted from a Business Manager System User
 * (see the plan's external-prerequisites section) — it doesn't expire, so
 * there's nothing here to refresh.
 */
export async function metaGraphFetch<T>(
  path: string,
  opts: MetaGraphFetchOptions = {},
): Promise<T> {
  const { method = "GET", params = {} } = opts;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${GRAPH_API_BASE}/${config.meta.graphApiVersion}${normalizedPath}`);

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }

  const res = await fetch(url.toString(), {
    method,
    headers: { Authorization: `Bearer ${config.meta.pageAccessToken}` },
    // Bound every request below the worker claim window. A POST aborted by
    // this timer still has an ambiguous outcome and callers must not replay
    // it automatically merely because the client stopped waiting.
    signal: AbortSignal.timeout(META_REQUEST_TIMEOUT_MS),
  });

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }

  const errorBody = (json as Partial<MetaGraphErrorResponse> | undefined)?.error;
  if (errorBody) {
    throw new MetaGraphApiError(res.status, errorBody);
  }
  if (!res.ok) {
    throw new Error(`Meta Graph API request failed: ${res.status} ${res.statusText}`);
  }

  return json as T;
}
