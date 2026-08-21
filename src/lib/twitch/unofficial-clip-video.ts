/**
 * ============================================================================
 * UNOFFICIAL / UNDOCUMENTED TWITCH ENDPOINT — READ BEFORE TOUCHING
 * ============================================================================
 *
 * Twitch's public Helix API has no endpoint that returns a clip's actual
 * video file — only a thumbnail JPG (`thumbnail_url`) and player/embed URLs
 * meant to be dropped into an <iframe>. To get a real, downloadable MP4 that
 * we can re-host elsewhere, this module does what the twitch.tv web player
 * itself does under the hood: it POSTs to Twitch's internal GraphQL gateway
 *
 *   POST https://gql.twitch.tv/gql
 *   Client-Id: kimne78kx3ncx6brgo4mv6wki5h1ko   (Twitch's public *web* client id — not ours)
 *
 * using a *persisted* query named `VideoAccessToken_Clip`. This is the same
 * trick essentially the entire Twitch-clip-downloading/reposting ecosystem
 * relies on. It is:
 *   - NOT part of Helix
 *   - NOT documented by Twitch
 *   - NOT sanctioned or guaranteed stable
 *   - liable to break (wrong persisted-query hash, renamed/removed response
 *     fields, added auth requirements) at any time, without notice
 *
 * That risk is intentionally isolated to this one file. If clip re-hosting
 * starts failing in production, THIS FILE is almost certainly why — check it
 * first, before assuming a bug elsewhere in the publish pipeline.
 *
 * VERIFY BEFORE TRUSTING IN PRODUCTION: the `PERSISTED_QUERY_SHA256` hash
 * below, and the response field names it assumes (`videoQualities`,
 * `playbackAccessToken`, `thumbnailURL`), reflect the well-documented public
 * pattern used by this trick at the time this file was written — but were
 * NOT re-verified against a live browser network trace during this change.
 * Before relying on this in production: open a clip on twitch.tv, watch the
 * Network tab for the `gql` request Twitch's own player makes, and confirm
 * the persisted-query hash and response shape still match what's coded here.
 * Update this comment (and the code) if they've drifted.
 * ============================================================================
 */

const GQL_URL = "https://gql.twitch.tv/gql";
const TWITCH_GQL_TIMEOUT_MS = 15_000;

// Twitch's own public web client id — used by the twitch.tv frontend itself,
// not a credential of ours. This is what makes the trick work without any
// user/app auth: gql.twitch.tv accepts unauthenticated requests as long as
// they present a recognized Client-Id.
const WEB_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";

// Best-known public hash for the `VideoAccessToken_Clip` persisted query as
// of this writing. UNVERIFIED against a live trace — see banner above.
const PERSISTED_QUERY_SHA256 = "36b89d2507fce29e5ca551df756d27c1cfe079e2609642b4390aa4c35796eb7";

export interface ClipVideoSource {
  videoUrl: string;
  /**
   * Best-effort guess at how long `videoUrl` stays valid. Signed Twitch
   * asset URLs are known to be short-lived; this is a conservative estimate,
   * not a value Twitch actually returns. Callers should treat `videoUrl` as
   * "consume promptly" regardless of whether this is set.
   */
  expiresHint?: Date;
}

/**
 * Thrown when no playable source video URL could be resolved for a clip,
 * via either the primary (GQL playback token) or fallback (thumbnail swap)
 * path. Carries a message specific enough for the publish UI to surface
 * directly to an admin.
 */
export class TwitchVideoUnavailableError extends Error {}

interface TwitchClipVideoQuality {
  frameRate: number;
  quality: string;
  sourceURL: string;
}

interface TwitchClipPlaybackAccessToken {
  signature: string;
  value: string;
}

interface TwitchClipGqlClip {
  id: string;
  thumbnailURL?: string | null;
  playbackAccessToken?: TwitchClipPlaybackAccessToken | null;
  videoQualities?: TwitchClipVideoQuality[] | null;
}

interface TwitchClipGqlData {
  clip: TwitchClipGqlClip | null;
}

interface TwitchGqlErrorEntry {
  message: string;
}

interface TwitchGqlEnvelope<T> {
  data?: T;
  errors?: TwitchGqlErrorEntry[];
}

/**
 * POSTs the persisted `VideoAccessToken_Clip` query for a single clip slug.
 * Twitch's gql endpoint accepts (and, for this query, is commonly seen to
 * return) a batched array even for a single operation, so we send an array
 * of one and defensively unwrap either an array or a bare object response.
 */
async function fetchClipGqlData(twitchClipSlug: string): Promise<TwitchClipGqlData | undefined> {
  const res = await fetch(GQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Client-Id": WEB_CLIENT_ID,
    },
    body: JSON.stringify([
      {
        operationName: "VideoAccessToken_Clip",
        variables: { slug: twitchClipSlug },
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash: PERSISTED_QUERY_SHA256,
          },
        },
      },
    ]),
    signal: AbortSignal.timeout(TWITCH_GQL_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`Twitch GQL request failed: ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as
    | TwitchGqlEnvelope<TwitchClipGqlData>[]
    | TwitchGqlEnvelope<TwitchClipGqlData>;
  const envelope = Array.isArray(json) ? json[0] : json;

  if (envelope?.errors?.length) {
    throw new Error(`Twitch GQL returned errors: ${envelope.errors.map((e) => e.message).join("; ")}`);
  }

  return envelope?.data;
}

/** Picks the highest-quality available source, sorting numerically on the `quality` field (e.g. "1080", "720"). */
function pickBestQuality(
  qualities: TwitchClipVideoQuality[],
): TwitchClipVideoQuality | undefined {
  return [...qualities].sort((a, b) => Number(b.quality) - Number(a.quality))[0];
}

function buildSignedSourceUrl(
  sourceURL: string,
  token: TwitchClipPlaybackAccessToken,
): string {
  const params = new URLSearchParams({ sig: token.signature, token: token.value });
  return `${sourceURL}?${params.toString()}`;
}

/**
 * Fallback for when the primary path can't produce a usable signed source
 * URL (e.g. `videoQualities`/`playbackAccessToken` came back empty or the
 * persisted query itself has rotated and Twitch stopped returning them).
 * Twitch clip thumbnails are generated from the clip's underlying video
 * asset, and swapping the thumbnail's `-preview-<W>x<H>.jpg` suffix for
 * `.mp4` on the same asset path has historically recovered a playable (if
 * lower-bitrate or occasionally stale) MP4. This is well known to be
 * unreliable and may already be dead by the time this runs — it's only
 * attempted because it's free to try and needs no extra network round trip.
 */
function thumbnailUrlToVideoUrl(thumbnailUrl: string): string | undefined {
  const match = thumbnailUrl.match(/^(.*)-preview-\d+x\d+\.jpg$/);
  const base = match?.[1];
  if (!base) return undefined;
  return `${base}.mp4`;
}

/**
 * Resolves a playable source video URL for a Twitch clip, given the clip's
 * slug (Helix's `TwitchClip.id`/`url` slug — the same identifier used in
 * `twitch.tv/<channel>/clip/<slug>`).
 *
 * Primary path: fetches Twitch's internal `VideoAccessToken_Clip` GQL query
 * and combines `videoQualities[]` (picking the highest quality available)
 * with the `playbackAccessToken` signature/token to build a signed source
 * MP4 URL — this is exactly what the twitch.tv player itself plays.
 *
 * Fallback path: if the GQL response came back but didn't include usable
 * video qualities/token, attempts a thumbnail-URL string swap on whatever
 * `thumbnailURL` the same response did include. Not attempted if the GQL
 * request failed outright (network/HTTP failure, or a malformed/errored
 * response) — in that case there's no thumbnail to work from either.
 *
 * No caching: these URLs are short-lived and signed, so every caller should
 * request a fresh one immediately before use rather than persisting it.
 *
 * @throws {TwitchVideoUnavailableError} if neither path yields a usable URL.
 */
export async function fetchClipSourceVideoUrl(twitchClipSlug: string): Promise<ClipVideoSource> {
  let gqlData: TwitchClipGqlData | undefined;
  let gqlError: unknown;

  try {
    gqlData = await fetchClipGqlData(twitchClipSlug);
  } catch (err) {
    gqlError = err;
  }

  const clip = gqlData?.clip;

  if (clip?.playbackAccessToken && clip.videoQualities && clip.videoQualities.length > 0) {
    const best = pickBestQuality(clip.videoQualities);
    if (best) {
      return {
        videoUrl: buildSignedSourceUrl(best.sourceURL, clip.playbackAccessToken),
        // Conservative guess — see ClipVideoSource.expiresHint doc.
        expiresHint: new Date(Date.now() + 5 * 60 * 1000),
      };
    }
  }

  const fallbackVideoUrl = clip?.thumbnailURL
    ? thumbnailUrlToVideoUrl(clip.thumbnailURL)
    : undefined;
  if (fallbackVideoUrl) {
    return { videoUrl: fallbackVideoUrl };
  }

  const reason = gqlError instanceof Error ? gqlError.message : "no usable video source in response";
  throw new TwitchVideoUnavailableError(
    `Could not resolve a source video URL for Twitch clip "${twitchClipSlug}" (${reason}). ` +
      "This clip may have expired, or Twitch's undocumented gql.twitch.tv endpoint used by " +
      "src/lib/twitch/unofficial-clip-video.ts may have changed — see the comment banner at the top of that file.",
  );
}
