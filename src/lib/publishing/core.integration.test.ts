import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { type Db } from "@/db/client";
import * as schema from "@/db/schema";
import { clipPublications, clips, publicationAttempts } from "@/db/schema";
import { MetaGraphApiError } from "@/lib/meta/client";

vi.mock("@/lib/meta/instagram", () => ({
  createReelsContainer: vi.fn(),
  pollContainerStatus: vi.fn(),
  publishContainer: vi.fn(),
  getMediaPermalink: vi.fn(),
}));
vi.mock("@/lib/meta/facebook", () => ({
  publishPageVideo: vi.fn(),
  getVideoPermalink: vi.fn(),
}));
vi.mock("@/lib/media/rehost-clip-video", () => ({
  rehostClipVideo: vi.fn(),
}));
vi.mock("@/lib/twitch/unofficial-clip-video", () => ({
  fetchClipSourceVideoUrl: vi.fn(),
}));

import {
  createReelsContainer,
  pollContainerStatus,
  publishContainer,
  getMediaPermalink,
} from "@/lib/meta/instagram";
import { publishPageVideo, getVideoPermalink } from "@/lib/meta/facebook";
import { rehostClipVideo } from "@/lib/media/rehost-clip-video";
import { fetchClipSourceVideoUrl } from "@/lib/twitch/unofficial-clip-video";
import { claimImmediatePublish } from "./repository";
import { publishClaimedClip, PublishClaimError } from "./core";

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
const sqlClient = postgres(testDatabaseUrl, {
  max: 8,
  prepare: false,
  connect_timeout: 15,
});
const db: Db = drizzle(sqlClient, { schema });
const fixtureClipIds = new Set<string>();
const runId = randomUUID();
const targets = {
  instagramUserId: `core-ig-${runId}`,
  facebookPageId: `core-fb-${runId}`,
};

async function cleanupFixtures(): Promise<void> {
  const ids = [...fixtureClipIds];
  fixtureClipIds.clear();
  if (ids.length > 0) await db.delete(clips).where(inArray(clips.id, ids));
}

async function createClaimedClip(label: string) {
  const id = randomUUID();
  const twitchClipId = `core-${runId}-${label}-${id}`;
  fixtureClipIds.add(id);
  await db.insert(clips).values({
    id,
    twitchClipId,
    broadcasterId: `core-broadcaster-${runId}`,
    title: `Core fixture ${label}`,
    creatorName: "Integration Test",
    url: `https://clips.twitch.tv/${twitchClipId}`,
    embedUrl: `https://clips.twitch.tv/embed?clip=${twitchClipId}`,
    thumbnailUrl: `https://static-cdn.jtvnw.net/core/${id}.jpg`,
    viewCount: 0,
    durationSeconds: 30,
    clipCreatedAt: new Date(),
    streamDate: "2026-08-20",
    status: "approved",
    approvedAt: new Date(),
    proposedCaption: `An ORIGIN field note with ${label}.`,
  });
  const claim = await claimImmediatePublish(id, { db, targets });
  if (!claim) throw new Error(`Could not claim core fixture ${label}.`);
  return { clipId: id, claim };
}

async function loadPublication(publicationId: string) {
  const [row] = await db
    .select()
    .from(clipPublications)
    .where(eq(clipPublications.id, publicationId));
  if (!row) throw new Error("Fixture publication row is missing.");
  return row;
}

async function loadClip(clipId: string) {
  const [row] = await db.select().from(clips).where(eq(clips.id, clipId));
  if (!row) throw new Error("Fixture clip row is missing.");
  return row;
}

async function loadAttempt(attemptId: string) {
  const [row] = await db
    .select()
    .from(publicationAttempts)
    .where(eq(publicationAttempts.id, attemptId));
  if (!row) throw new Error("Fixture attempt row is missing.");
  return row;
}

beforeAll(async () => {
  const probe = await db.execute(
    sql`SELECT to_regclass('public.clips')::text AS "clipsTable"`,
  );
  const row = (probe as unknown as Array<{ clipsTable: string | null }>)[0];
  if (!row?.clipsTable) {
    throw new Error(
      "The disposable test database does not have the current schema. Apply migrations separately before running integration tests.",
    );
  }
});

beforeEach(() => {
  vi.mocked(fetchClipSourceVideoUrl).mockReset().mockResolvedValue({
    videoUrl: "https://twitch.example.test/source.mp4",
  });
  vi.mocked(rehostClipVideo).mockReset().mockResolvedValue({
    url: "https://blob.example.test/clips/rehosted.mp4",
    etag: "rehosted-etag",
    size: 1_000,
    contentType: "video/mp4",
  });
  vi.mocked(createReelsContainer).mockReset().mockResolvedValue("container-1");
  vi.mocked(pollContainerStatus).mockReset().mockResolvedValue("FINISHED");
  vi.mocked(publishContainer).mockReset().mockResolvedValue("ig-media-1");
  vi.mocked(getMediaPermalink).mockReset().mockResolvedValue("https://www.instagram.com/reel/ig-media-1");
  vi.mocked(publishPageVideo).mockReset().mockResolvedValue("fb-video-1");
  vi.mocked(getVideoPermalink).mockReset().mockResolvedValue("https://www.facebook.com/watch/?v=fb-video-1");
});

afterEach(cleanupFixtures);
afterAll(async () => {
  await cleanupFixtures();
  await sqlClient.end({ timeout: 5 });
});

describe("publishClaimedClip", () => {
  it("publishes both platforms, records permalinks, and flips the clip to published", async () => {
    const { clipId, claim } = await createClaimedClip("full-success");

    const result = await publishClaimedClip(claim, { db, targets });

    expect(result.instagram).toEqual({
      status: "published",
      permalink: "https://www.instagram.com/reel/ig-media-1",
    });
    expect(result.facebook).toEqual({
      status: "published",
      permalink: "https://www.facebook.com/watch/?v=fb-video-1",
    });
    expect(result.allPublished).toBe(true);
    expect(result.scheduleStatus).toBe("completed");

    const clip = await loadClip(clipId);
    expect(clip.status).toBe("published");
    expect(clip.publishedAt).toBeInstanceOf(Date);

    const attempt = await loadAttempt(claim.attemptId);
    expect(attempt.status).toBe("completed");
    expect(attempt.error).toBeNull();
    expect(attempt.lockedUntil).toBeNull();

    const publication = await loadPublication(claim.publicationId);
    expect(publication.instagramMediaId).toBe("ig-media-1");
    expect(publication.facebookPostId).toBe("fb-video-1");
    expect(publication.videoAssetUrl).toBe("https://blob.example.test/clips/rehosted.mp4");
  });

  it("skips a platform already published and never re-calls its create step", async () => {
    const { clipId, claim } = await createClaimedClip("instagram-already-published");
    await db
      .update(clipPublications)
      .set({
        instagramPublishStatus: "published",
        instagramMediaId: "ig-preexisting",
        instagramPermalink: "https://www.instagram.com/reel/ig-preexisting",
        instagramPublishedAt: new Date(),
      })
      .where(eq(clipPublications.id, claim.publicationId));

    const result = await publishClaimedClip(claim, { db, targets });

    expect(result.instagram).toEqual({
      status: "skipped",
      permalink: "https://www.instagram.com/reel/ig-preexisting",
    });
    expect(createReelsContainer).not.toHaveBeenCalled();
    expect(pollContainerStatus).not.toHaveBeenCalled();
    expect(publishContainer).not.toHaveBeenCalled();
    expect(result.facebook.status).toBe("published");
    expect(result.allPublished).toBe(true);

    const clip = await loadClip(clipId);
    expect(clip.status).toBe("published");
  });

  it("skips Facebook when already published and never re-calls publishPageVideo", async () => {
    const { claim } = await createClaimedClip("facebook-already-published");
    await db
      .update(clipPublications)
      .set({
        facebookPublishStatus: "published",
        facebookPostId: "fb-preexisting",
        facebookPermalink: "https://www.facebook.com/watch/?v=fb-preexisting",
        facebookPublishedAt: new Date(),
      })
      .where(eq(clipPublications.id, claim.publicationId));

    const result = await publishClaimedClip(claim, { db, targets });

    expect(result.facebook).toEqual({
      status: "skipped",
      permalink: "https://www.facebook.com/watch/?v=fb-preexisting",
    });
    expect(publishPageVideo).not.toHaveBeenCalled();
    expect(result.instagram.status).toBe("published");
  });

  it("marks a typed Meta rejection as failed, not manual_review", async () => {
    const { clipId, claim } = await createClaimedClip("instagram-typed-error");
    vi.mocked(createReelsContainer).mockRejectedValue(
      new MetaGraphApiError(400, {
        code: 100,
        message: "Invalid parameter",
        type: "OAuthException",
        fbtrace_id: "trace-1",
      }),
    );

    const result = await publishClaimedClip(claim, { db, targets });

    expect(result.instagram.status).toBe("failed");
    expect(result.instagram.error).toBe("Meta rejected the request (code 100).");
    expect(result.scheduleStatus).toBe("failed");

    const publication = await loadPublication(claim.publicationId);
    expect(publication.instagramPublishStatus).toBe("failed");
    expect(publication.instagramPublishError).toBe("Meta rejected the request (code 100).");

    const clip = await loadClip(clipId);
    expect(clip.status).toBe("approved");
  });

  it("marks an ambiguous (non-Meta) post error as manual_review, not failed", async () => {
    const { clipId, claim } = await createClaimedClip("facebook-ambiguous-error");
    vi.mocked(publishPageVideo).mockRejectedValue(new Error("socket hang up"));

    const result = await publishClaimedClip(claim, { db, targets });

    expect(result.facebook.status).toBe("manual_review");
    expect(result.facebook.error).toBe(
      "The platform request failed before publication could be confirmed.",
    );
    expect(result.scheduleStatus).toBe("manual_review");

    const publication = await loadPublication(claim.publicationId);
    expect(publication.facebookPublishStatus).toBe("manual_review");

    const clip = await loadClip(clipId);
    expect(clip.status).toBe("approved");

    const attempt = await loadAttempt(claim.attemptId);
    expect(attempt.status).toBe("manual_review");
  });

  it("reuses an existing Instagram container on retry instead of creating a new one", async () => {
    const { claim } = await createClaimedClip("instagram-container-reuse");
    await db
      .update(clipPublications)
      .set({ instagramContainerId: "container-from-earlier-attempt" })
      .where(eq(clipPublications.id, claim.publicationId));

    const result = await publishClaimedClip(claim, { db, targets });

    expect(createReelsContainer).not.toHaveBeenCalled();
    expect(pollContainerStatus).toHaveBeenCalledWith("container-from-earlier-attempt");
    expect(publishContainer).toHaveBeenCalledWith(
      expect.objectContaining({ containerId: "container-from-earlier-attempt" }),
    );
    expect(result.instagram.status).toBe("published");
  });

  it("clears the Instagram container and fails when the container status is not FINISHED", async () => {
    const { claim } = await createClaimedClip("instagram-container-error-status");
    vi.mocked(pollContainerStatus).mockResolvedValue("ERROR");

    const result = await publishClaimedClip(claim, { db, targets });

    expect(result.instagram.status).toBe("failed");
    expect(result.instagram.error).toBe("Instagram container is error.");
    expect(publishContainer).not.toHaveBeenCalled();

    const publication = await loadPublication(claim.publicationId);
    expect(publication.instagramContainerId).toBeNull();
    expect(publication.instagramPublishStatus).toBe("failed");
  });

  it("reuses an already-rehosted video asset without re-fetching from Twitch", async () => {
    const { claim } = await createClaimedClip("video-asset-reuse");
    await db
      .update(clipPublications)
      .set({
        videoAssetUrl: "https://blob.example.test/clips/already-hosted.mp4",
        videoAssetEtag: "already-hosted-etag",
        videoAssetFetchedAt: new Date(),
        blobCleanupStatus: "retained",
      })
      .where(eq(clipPublications.id, claim.publicationId));

    await publishClaimedClip(claim, { db, targets });

    expect(fetchClipSourceVideoUrl).not.toHaveBeenCalled();
    expect(rehostClipVideo).not.toHaveBeenCalled();
    expect(createReelsContainer).toHaveBeenCalledWith(
      expect.objectContaining({ videoUrl: "https://blob.example.test/clips/already-hosted.mp4" }),
    );
  });

  it("re-fetches and resets blob-cleanup bookkeeping when the prior asset was deleted", async () => {
    const { claim } = await createClaimedClip("video-asset-refetch-after-delete");
    await db
      .update(clipPublications)
      .set({
        videoAssetUrl: null,
        videoAssetEtag: null,
        blobCleanupStatus: "deleted",
        blobDeletedAt: new Date(),
      })
      .where(eq(clipPublications.id, claim.publicationId));

    await publishClaimedClip(claim, { db, targets });

    expect(fetchClipSourceVideoUrl).toHaveBeenCalledTimes(1);
    expect(rehostClipVideo).toHaveBeenCalledTimes(1);

    const publication = await loadPublication(claim.publicationId);
    expect(publication.videoAssetUrl).toBe("https://blob.example.test/clips/rehosted.mp4");
    expect(publication.videoAssetEtag).toBe("rehosted-etag");
    expect(publication.blobCleanupStatus).toBe("retained");
    expect(publication.blobDeletedAt).toBeNull();
  });

  it("fails the attempt and never calls Meta when video acquisition throws", async () => {
    const { clipId, claim } = await createClaimedClip("video-acquisition-failure");
    vi.mocked(fetchClipSourceVideoUrl).mockRejectedValue(new Error("clip has expired"));

    await expect(publishClaimedClip(claim, { db, targets })).rejects.toThrow(
      "Could not acquire the clip video.",
    );

    expect(createReelsContainer).not.toHaveBeenCalled();
    expect(publishPageVideo).not.toHaveBeenCalled();

    const attempt = await loadAttempt(claim.attemptId);
    expect(attempt.status).toBe("failed");
    expect(attempt.error).toBe("Could not acquire the clip video.");
    expect(attempt.lockedUntil).toBeNull();

    const publication = await loadPublication(claim.publicationId);
    expect(publication.videoAssetError).toBe("clip has expired");

    const clip = await loadClip(clipId);
    expect(clip.status).toBe("approved");
  });

  it("throws PublishClaimError instead of publishing when the claim lease already expired", async () => {
    const { claim } = await createClaimedClip("expired-claim");
    await db
      .update(publicationAttempts)
      .set({ lockedUntil: new Date(Date.now() - 1_000) })
      .where(eq(publicationAttempts.id, claim.attemptId));

    await expect(publishClaimedClip(claim, { db, targets })).rejects.toThrow(PublishClaimError);
    expect(createReelsContainer).not.toHaveBeenCalled();
    expect(fetchClipSourceVideoUrl).not.toHaveBeenCalled();
  });
});
