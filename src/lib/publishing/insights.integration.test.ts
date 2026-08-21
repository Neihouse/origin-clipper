import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db } from "@/db/client";
import * as schema from "@/db/schema";
import { clipPublicationInsights, clipPublications, clips } from "@/db/schema";
import { MetaGraphApiError } from "@/lib/meta/client";

vi.mock("@/lib/meta/insights", () => ({
  getInstagramMediaInsights: vi.fn(),
  getFacebookVideoInsights: vi.fn(),
}));

import { getFacebookVideoInsights, getInstagramMediaInsights } from "@/lib/meta/insights";
import { refreshInsightsForClip, runDueInsightsRefresh } from "./insights";

function requireTestDatabaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL?.trim();
  if (!value) {
    throw new Error(
      "TEST_DATABASE_URL is required for publishing integration tests. Use a disposable database only.",
    );
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") throw new Error();
  } catch {
    throw new Error("TEST_DATABASE_URL must be a valid PostgreSQL connection URL.");
  }
  return value;
}

const testDatabaseUrl = requireTestDatabaseUrl();
const sqlClient = postgres(testDatabaseUrl, { max: 8, prepare: false, connect_timeout: 15 });
const db: Db = drizzle(sqlClient, { schema });
const fixtureClipIds = new Set<string>();
const runId = randomUUID();

async function cleanupFixtures(): Promise<void> {
  const ids = [...fixtureClipIds];
  fixtureClipIds.clear();
  if (ids.length > 0) await db.delete(clips).where(inArray(clips.id, ids));
}

async function createClip(label: string): Promise<string> {
  const id = randomUUID();
  const twitchClipId = `insights-${runId}-${label}-${id}`;
  fixtureClipIds.add(id);
  await db.insert(clips).values({
    id,
    twitchClipId,
    broadcasterId: `insights-broadcaster-${runId}`,
    title: `Insights fixture ${label}`,
    creatorName: "Integration Test",
    url: `https://clips.twitch.tv/${twitchClipId}`,
    embedUrl: `https://clips.twitch.tv/embed?clip=${twitchClipId}`,
    thumbnailUrl: `https://static-cdn.jtvnw.net/insights/${id}.jpg`,
    viewCount: 0,
    durationSeconds: 30,
    clipCreatedAt: new Date(),
    streamDate: "2026-08-20",
    status: "approved",
    approvedAt: new Date(),
    proposedCaption: `An ORIGIN field note for ${label}.`,
  });
  return id;
}

async function createPublication(
  clipId: string,
  values: Partial<typeof clipPublications.$inferInsert> = {},
): Promise<void> {
  await db.insert(clipPublications).values({ clipId, ...values });
}

async function loadInsights(clipId: string) {
  const [row] = await db
    .select()
    .from(clipPublicationInsights)
    .where(eq(clipPublicationInsights.clipId, clipId));
  return row ?? null;
}

beforeAll(async () => {
  const probe = await db.execute(
    sql`SELECT to_regclass('public.clip_publication_insights')::text AS "table"`,
  );
  const row = (probe as unknown as Array<{ table: string | null }>)[0];
  if (!row?.table) {
    throw new Error(
      "The disposable test database is missing clip_publication_insights. Apply migrations before running integration tests.",
    );
  }
});

beforeEach(() => {
  vi.mocked(getInstagramMediaInsights).mockReset();
  vi.mocked(getFacebookVideoInsights).mockReset();
});

afterEach(cleanupFixtures);
afterAll(async () => {
  await cleanupFixtures();
  await sqlClient.end({ timeout: 5 });
});

describe("refreshInsightsForClip", () => {
  it("fetches and stores metrics for both platforms when both are published", async () => {
    const clipId = await createClip("both-published");
    await createPublication(clipId, {
      instagramPublishStatus: "published",
      instagramMediaId: "ig-media-1",
      facebookPublishStatus: "published",
      facebookPostId: "fb-video-1",
    });
    vi.mocked(getInstagramMediaInsights).mockResolvedValue({
      views: 100,
      reach: 80,
      likes: 10,
      comments: 2,
      shares: 1,
      saved: 3,
    });
    vi.mocked(getFacebookVideoInsights).mockResolvedValue({
      videoViews: 500,
      reactions: 20,
      comments: 5,
      shares: 7,
    });

    const result = await refreshInsightsForClip(clipId, { db });

    expect(result).toEqual({ clipId, instagram: "refreshed", facebook: "refreshed" });
    expect(getInstagramMediaInsights).toHaveBeenCalledWith("ig-media-1");
    expect(getFacebookVideoInsights).toHaveBeenCalledWith("fb-video-1");

    const insights = await loadInsights(clipId);
    expect(insights).not.toBeNull();
    expect(insights?.instagramViews).toBe(100);
    expect(insights?.instagramSaved).toBe(3);
    expect(insights?.instagramInsightsFetchedAt).toBeInstanceOf(Date);
    expect(insights?.instagramInsightsError).toBeNull();
    expect(insights?.facebookVideoViews).toBe(500);
    expect(insights?.facebookShares).toBe(7);
    expect(insights?.facebookInsightsFetchedAt).toBeInstanceOf(Date);
    expect(insights?.facebookInsightsError).toBeNull();
  });

  it("skips a platform that hasn't published yet and never calls its fetcher", async () => {
    const clipId = await createClip("facebook-not-published");
    await createPublication(clipId, {
      instagramPublishStatus: "published",
      instagramMediaId: "ig-media-2",
      facebookPublishStatus: "not_started",
    });
    vi.mocked(getInstagramMediaInsights).mockResolvedValue({
      views: 10,
      reach: null,
      likes: null,
      comments: null,
      shares: null,
      saved: null,
    });

    const result = await refreshInsightsForClip(clipId, { db });

    expect(result.instagram).toBe("refreshed");
    expect(result.facebook).toBe("skipped");
    expect(getFacebookVideoInsights).not.toHaveBeenCalled();

    const insights = await loadInsights(clipId);
    expect(insights?.instagramViews).toBe(10);
    expect(insights?.facebookInsightsFetchedAt).toBeNull();
    expect(insights?.facebookVideoViews).toBeNull();
  });

  it("never defaults an absent metric to 0", async () => {
    const clipId = await createClip("null-metrics");
    await createPublication(clipId, {
      instagramPublishStatus: "published",
      instagramMediaId: "ig-media-3",
    });
    vi.mocked(getInstagramMediaInsights).mockResolvedValue({
      views: null,
      reach: null,
      likes: null,
      comments: null,
      shares: null,
      saved: null,
    });

    await refreshInsightsForClip(clipId, { db });

    const insights = await loadInsights(clipId);
    expect(insights?.instagramViews).toBeNull();
    expect(insights?.instagramViews).not.toBe(0);
  });

  it("on a per-platform fetch failure, writes only that platform's error and leaves the other platform's last-good metrics untouched", async () => {
    const clipId = await createClip("partial-failure");
    await createPublication(clipId, {
      instagramPublishStatus: "published",
      instagramMediaId: "ig-media-4",
      facebookPublishStatus: "published",
      facebookPostId: "fb-video-4",
    });
    const priorFetchedAt = new Date("2026-08-01T00:00:00.000Z");
    await db.insert(clipPublicationInsights).values({
      clipId,
      facebookInsightsFetchedAt: priorFetchedAt,
      facebookVideoViews: 999,
      facebookReactions: 40,
      facebookComments: 8,
      facebookShares: 6,
      facebookInsightsError: null,
    });
    vi.mocked(getInstagramMediaInsights).mockResolvedValue({
      views: 55,
      reach: 44,
      likes: 33,
      comments: 2,
      shares: 1,
      saved: 0,
    });
    vi.mocked(getFacebookVideoInsights).mockRejectedValue(
      new MetaGraphApiError(400, {
        code: 100,
        message: "Invalid parameter",
        type: "OAuthException",
        fbtrace_id: "trace-insights-1",
      }),
    );

    const result = await refreshInsightsForClip(clipId, { db });

    expect(result.instagram).toBe("refreshed");
    expect(result.facebook).toBe("error");

    const insights = await loadInsights(clipId);
    expect(insights?.instagramViews).toBe(55);
    expect(insights?.instagramInsightsError).toBeNull();
    // Facebook's last-good numbers and fetched-at survive the failed refresh.
    expect(insights?.facebookVideoViews).toBe(999);
    expect(insights?.facebookInsightsFetchedAt?.toISOString()).toBe(priorFetchedAt.toISOString());
    expect(insights?.facebookInsightsError).toBe(
      "Meta rejected the insights request (code 100).",
    );
  });

  it("throws when the clip has no clipPublications row", async () => {
    await expect(refreshInsightsForClip(randomUUID(), { db })).rejects.toThrow(
      /No clipPublications row/,
    );
  });
});

describe("runDueInsightsRefresh", () => {
  it("refreshes published clips within the window and skips clips outside it or never published", async () => {
    const inWindowClipId = await createClip("due-in-window");
    await createPublication(inWindowClipId, {
      instagramPublishStatus: "published",
      instagramMediaId: "ig-due-1",
      instagramPublishedAt: new Date(),
    });

    const outOfWindowClipId = await createClip("due-out-of-window");
    await createPublication(outOfWindowClipId, {
      instagramPublishStatus: "published",
      instagramMediaId: "ig-due-2",
      instagramPublishedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });

    const unpublishedClipId = await createClip("due-unpublished");
    await createPublication(unpublishedClipId, {
      instagramPublishStatus: "not_started",
    });

    vi.mocked(getInstagramMediaInsights).mockResolvedValue({
      views: 1,
      reach: 1,
      likes: 1,
      comments: 1,
      shares: 1,
      saved: 1,
    });

    const summary = await runDueInsightsRefresh({ db });

    expect(getInstagramMediaInsights).toHaveBeenCalledWith("ig-due-1");
    expect(getInstagramMediaInsights).not.toHaveBeenCalledWith("ig-due-2");
    expect(summary.attempted).toBeGreaterThanOrEqual(1);
    expect(summary.refreshed).toBeGreaterThanOrEqual(1);

    const outOfWindowInsights = await loadInsights(outOfWindowClipId);
    expect(outOfWindowInsights).toBeNull();
    const unpublishedInsights = await loadInsights(unpublishedClipId);
    expect(unpublishedInsights).toBeNull();
  });
});
