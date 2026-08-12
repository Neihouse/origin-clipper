import { config } from "@/lib/config";
import type { TwitchAppTokenResponse, TwitchClip, TwitchClipsResponse } from "./types";

const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const CLIPS_URL = "https://api.twitch.tv/helix/clips";
const PAGE_SIZE = 100;
// Safety cap on pagination so a runaway channel can't turn one cron run into
// an unbounded number of Twitch API calls.
const MAX_PAGES = 10;

interface CachedToken {
  value: string;
  expiresAt: number;
}

let cachedToken: CachedToken | undefined;

/**
 * Fetches (and caches in-memory) a Twitch app access token via the client
 * credentials grant. Sufficient for read-only clip retrieval; no user
 * authorization is required. See README for what user-authorized scopes
 * would be needed if automated clip creation or publishing is added later.
 */
async function getAppAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value;
  }

  const body = new URLSearchParams({
    client_id: config.twitch.clientId,
    client_secret: config.twitch.clientSecret,
    grant_type: "client_credentials",
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`Twitch app token request failed: ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as TwitchAppTokenResponse;
  cachedToken = {
    value: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  return cachedToken.value;
}

export interface FetchClipsWindow {
  broadcasterId: string;
  startedAt: Date;
  endedAt: Date;
}

/**
 * Fetches all Twitch clips for a broadcaster created within [startedAt, endedAt),
 * following pagination up to MAX_PAGES pages (MAX_PAGES * PAGE_SIZE clips).
 */
export async function fetchClipsInWindow({
  broadcasterId,
  startedAt,
  endedAt,
}: FetchClipsWindow): Promise<TwitchClip[]> {
  const token = await getAppAccessToken();
  const clips: TwitchClip[] = [];
  let cursor: string | undefined;
  let page = 0;

  do {
    const params = new URLSearchParams({
      broadcaster_id: broadcasterId,
      started_at: startedAt.toISOString(),
      ended_at: endedAt.toISOString(),
      first: String(PAGE_SIZE),
    });
    if (cursor) params.set("after", cursor);

    const res = await fetch(`${CLIPS_URL}?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Client-Id": config.twitch.clientId,
      },
    });

    if (!res.ok) {
      throw new Error(`Twitch clips request failed: ${res.status} ${res.statusText}`);
    }

    const json = (await res.json()) as TwitchClipsResponse;
    clips.push(...json.data);
    cursor = json.pagination?.cursor || undefined;
    page += 1;
  } while (cursor && page < MAX_PAGES);

  return clips;
}
