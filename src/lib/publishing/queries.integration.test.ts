import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type Db } from "@/db/client";
import * as schema from "@/db/schema";
import {
  clipPublicationInsights,
  clipPublications,
  clips,
  publicationAttempts,
  type ClipStatus,
  type InstagramCollaborationStatus,
  type PlatformPublishStatus,
  type PublicationAttemptStatus,
  type PublicationTrigger,
} from "@/db/schema";
import { getCadencePublishingDashboard, getInsightsForClip } from "./queries";

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
  instagramUserId: `queries-ig-${runId}`,
  facebookPageId: `queries-fb-${runId}`,
};

async function cleanupFixtures(): Promise<void> {
  const ids = [...fixtureClipIds];
  fixtureClipIds.clear();
  if (ids.length > 0) await db.delete(clips).where(inArray(clips.id, ids));
}

async function createClip(label: string, status: ClipStatus): Promise<string> {
  const id = randomUUID();
  const twitchClipId = `queries-${runId}-${label}-${id}`;
  fixtureClipIds.add(id);
  await db.insert(clips).values({
    id,
    twitchClipId,
    broadcasterId: `queries-broadcaster-${runId}`,
    title: `Queries fixture ${label}`,
    creatorName: "Integration Test",
    url: `https://clips.twitch.tv/${twitchClipId}`,
    embedUrl: `https://clips.twitch.tv/embed?clip=${twitchClipId}`,
    thumbnailUrl: `https://static-cdn.jtvnw.net/queries/${id}.jpg`,
    viewCount: 0,
    durationSeconds: 30,
    clipCreatedAt: new Date(),
    streamDate: "2026-08-20",
    status,
    approvedAt: status === "approved" || status === "published" ? new Date() : null,
    proposedCaption: `An ORIGIN field note with ${label}.`,
  });
  return id;
}

async function createPublication(
  clipId: string,
  overrides: {
    instagramPublishStatus?: PlatformPublishStatus;
    facebookPublishStatus?: PlatformPublishStatus;
    blobCleanupStatus?: "retained" | "processing" | "deleted" | "failed";
    instagramCollaborationStatus?: InstagramCollaborationStatus;
    publishVerifiedAt?: Date | null;
  } = {},
): Promise<string> {
  const [row] = await db
    .insert(clipPublications)
    .values({
      clipId,
      instagramPublishStatus: overrides.instagramPublishStatus ?? "not_started",
      facebookPublishStatus: overrides.facebookPublishStatus ?? "not_started",
      blobCleanupStatus: overrides.blobCleanupStatus ?? "retained",
      instagramCollaborationStatus: overrides.instagramCollaborationStatus ?? "not_requested",
      publishVerifiedAt: overrides.publishVerifiedAt ?? null,
    })
    .returning({ id: clipPublications.id });
  if (!row) throw new Error("Fixture publication insert returned no row.");
  return row.id;
}

async function createAttempt(
  clipId: string,
  publicationId: string,
  overrides: {
    trigger: PublicationTrigger;
    status: PublicationAttemptStatus;
    scheduledFor?: Date | null;
    createdAt?: Date;
    claimedAt?: Date | null;
  },
): Promise<void> {
  const isProcessing = overrides.status === "processing";
  const isScheduled = overrides.status === "scheduled";
  const isTerminal = ["completed", "failed", "cancelled", "manual_review"].includes(
    overrides.status,
  );
  await db.insert(publicationAttempts).values({
    clipId,
    publicationId,
    trigger: overrides.trigger,
    status: overrides.status,
    scheduledFor: overrides.scheduledFor ?? null,
    authorizedAt: new Date(),
    authorizedCaption: "Integration authorization snapshot.",
    authorizedInstagramUserId: targets.instagramUserId,
    authorizedFacebookPageId: targets.facebookPageId,
    claimToken: isProcessing ? `claim-${randomUUID()}` : null,
    claimedAt: isProcessing ? (overrides.claimedAt ?? new Date()) : null,
    lockedUntil: isProcessing ? new Date(Date.now() + 60_000) : null,
    completedAt: isTerminal && !isScheduled ? new Date() : null,
    createdAt: overrides.createdAt ?? new Date(),
  });
}

async function assertDisposableDatabaseIsIdle(): Promise<void> {
  const probe = await db.execute(
    sql`SELECT to_regclass('public.clips')::text AS "clipsTable"`,
  );
  const row = (probe as unknown as Array<{ clipsTable: string | null }>)[0];
  if (!row?.clipsTable) {
    throw new Error(
      "The disposable test database does not have the current schema. Apply migrations separately before running integration tests.",
    );
  }
}

beforeAll(assertDisposableDatabaseIsIdle);
afterEach(cleanupFixtures);
afterAll(async () => {
  await cleanupFixtures();
  await sqlClient.end({ timeout: 5 });
});

describe("getCadencePublishingDashboard", () => {
  it("rejects an invalid or backwards time window before touching the database", async () => {
    const now = new Date("2026-08-20T12:00:00Z");
    await expect(
      getCadencePublishingDashboard(
        { now, horizon: new Date(now.getTime() - 1) },
        db,
      ),
    ).rejects.toThrow("Cadence dashboard requires a valid current time and future horizon.");
  });

  it("excludes clips outside approved/published status entirely", async () => {
    const now = new Date();
    const horizon = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    const shortlistedId = await createClip("excluded-shortlisted", "shortlisted");
    const publicationId = await createPublication(shortlistedId);
    await createAttempt(shortlistedId, publicationId, {
      trigger: "immediate",
      status: "manual_review",
    });

    const dashboard = await getCadencePublishingDashboard({ now, horizon }, db);

    expect(dashboard.rows.find((row) => row.clipId === shortlistedId)).toBeUndefined();
    expect(dashboard.metrics.manualReviewCount).toBe(0);
    expect(dashboard.totalCount).toBe(0);
  });

  it("classifies each attention-worthy state into the correct metric, priority, and queue eligibility", async () => {
    const now = new Date();
    const horizon = new Date(now.getTime() + 2 * 60 * 60 * 1000);

    const manualReviewId = await createClip("manual-review", "approved");
    const manualReviewPubId = await createPublication(manualReviewId);
    await createAttempt(manualReviewId, manualReviewPubId, {
      trigger: "immediate",
      status: "manual_review",
    });

    const overdueId = await createClip("overdue-scheduled", "approved");
    const overduePubId = await createPublication(overdueId);
    await createAttempt(overdueId, overduePubId, {
      trigger: "scheduled",
      status: "scheduled",
      scheduledFor: new Date(now.getTime() - 30 * 60 * 1000),
    });

    const processingId = await createClip("processing", "approved");
    const processingPubId = await createPublication(processingId);
    await createAttempt(processingId, processingPubId, {
      trigger: "immediate",
      status: "processing",
    });

    const failedId = await createClip("failed", "approved");
    const failedPubId = await createPublication(failedId);
    await createAttempt(failedId, failedPubId, {
      trigger: "immediate",
      status: "failed",
    });

    const cleanupFailedId = await createClip("cleanup-failed", "published");
    await createPublication(cleanupFailedId, {
      instagramPublishStatus: "published",
      facebookPublishStatus: "published",
      blobCleanupStatus: "failed",
      instagramCollaborationStatus: "accepted",
      publishVerifiedAt: now,
    });

    const followUpId = await createClip("post-publish-followup", "published");
    await createPublication(followUpId, {
      instagramPublishStatus: "published",
      facebookPublishStatus: "published",
      instagramCollaborationStatus: "pending",
      publishVerifiedAt: null,
    });

    const cleanClipId = await createClip("fully-published-clean", "published");
    await createPublication(cleanClipId, {
      instagramPublishStatus: "published",
      facebookPublishStatus: "published",
      instagramCollaborationStatus: "accepted",
      publishVerifiedAt: now,
    });

    const upcomingId = await createClip("upcoming-scheduled", "approved");
    const upcomingPubId = await createPublication(upcomingId);
    await createAttempt(upcomingId, upcomingPubId, {
      trigger: "scheduled",
      status: "scheduled",
      scheduledFor: new Date(now.getTime() + 30 * 60 * 1000),
    });

    const unscheduledId = await createClip("approved-unscheduled", "approved");

    const completedNoOpId = await createClip("completed-attempt", "approved");
    const completedPubId = await createPublication(completedNoOpId);
    await createAttempt(completedNoOpId, completedPubId, {
      trigger: "immediate",
      status: "completed",
    });

    const dashboard = await getCadencePublishingDashboard({ now, horizon, limit: 50 }, db);
    const byId = new Map(dashboard.rows.map((row, index) => [row.clipId, index]));

    expect(dashboard.metrics.manualReviewCount).toBe(1);
    expect(dashboard.metrics.overdueCount).toBe(1);
    expect(dashboard.metrics.processingCount).toBe(1);
    expect(dashboard.metrics.failedCount).toBe(1);
    expect(dashboard.metrics.cleanupFailedCount).toBe(1);
    expect(dashboard.metrics.collaborationFollowUpCount).toBe(1);
    expect(dashboard.metrics.unverifiedCount).toBe(1);
    expect(dashboard.metrics.postPublishFollowUpCount).toBe(1);
    expect(dashboard.metrics.upcomingScheduledCount).toBe(1);
    expect(dashboard.metrics.approvedUnscheduledCount).toBe(2);
    expect(dashboard.metrics.operatorAttentionCount).toBe(6);
    // totalCount reflects queueEligible, which is broader than operatorAttentionCount:
    // it also includes scheduled clips due within the horizon (not just overdue ones),
    // so the upcoming-scheduled fixture is counted here even though it isn't urgent.
    expect(dashboard.totalCount).toBe(7);

    for (const id of [
      manualReviewId,
      overdueId,
      processingId,
      failedId,
      cleanupFailedId,
      followUpId,
      upcomingId,
    ]) {
      expect(byId.has(id)).toBe(true);
    }
    for (const id of [cleanClipId, unscheduledId, completedNoOpId]) {
      expect(byId.has(id)).toBe(false);
    }

    expect(byId.get(manualReviewId)).toBeLessThan(byId.get(overdueId)!);
    expect(byId.get(overdueId)).toBeLessThan(byId.get(processingId)!);
    expect(byId.get(processingId)).toBeLessThan(byId.get(failedId)!);
    expect(byId.get(failedId)).toBeLessThan(byId.get(cleanupFailedId)!);
    expect(byId.get(cleanupFailedId)).toBeLessThan(byId.get(followUpId)!);
    expect(byId.get(followUpId)).toBeLessThan(byId.get(upcomingId)!);
  });

  it("excludes a scheduled attempt just beyond the horizon while an identical one at the horizon is included", async () => {
    const now = new Date();
    const horizon = new Date(now.getTime() + 60 * 60 * 1000);

    const atHorizonId = await createClip("at-horizon", "approved");
    const atHorizonPubId = await createPublication(atHorizonId);
    await createAttempt(atHorizonId, atHorizonPubId, {
      trigger: "scheduled",
      status: "scheduled",
      scheduledFor: horizon,
    });

    const beyondHorizonId = await createClip("beyond-horizon", "approved");
    const beyondHorizonPubId = await createPublication(beyondHorizonId);
    await createAttempt(beyondHorizonId, beyondHorizonPubId, {
      trigger: "scheduled",
      status: "scheduled",
      scheduledFor: new Date(horizon.getTime() + 1000),
    });

    const dashboard = await getCadencePublishingDashboard({ now, horizon }, db);
    const ids = dashboard.rows.map((row) => row.clipId);

    expect(ids).toContain(atHorizonId);
    expect(ids).not.toContain(beyondHorizonId);
    expect(dashboard.metrics.upcomingScheduledCount).toBe(1);
    expect(dashboard.metrics.approvedUnscheduledCount).toBe(0);
    expect(dashboard.metrics.nextDueAt?.getTime()).toBe(horizon.getTime());
  });

  it("truncates the queue to the requested limit while keeping totalCount uncapped", async () => {
    const now = new Date();
    const horizon = new Date(now.getTime() + 2 * 60 * 60 * 1000);

    // All four attempts tie on attentionPriority (failed), so the queue orders
    // them by queueTime (derived from created_at) — assign explicit, strictly
    // increasing timestamps so truncation is deterministic regardless of
    // wall-clock/DB round-trip timing between inserts.
    const failedIds: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const clipId = await createClip(`limit-failed-${index}`, "approved");
      const publicationId = await createPublication(clipId);
      await createAttempt(clipId, publicationId, {
        trigger: "immediate",
        status: "failed",
        createdAt: new Date(now.getTime() - (4 - index) * 60 * 1000),
      });
      failedIds.push(clipId);
    }

    const dashboard = await getCadencePublishingDashboard({ now, horizon, limit: 2 }, db);

    expect(dashboard.rows).toHaveLength(2);
    expect(dashboard.totalCount).toBe(4);
    expect(dashboard.metrics.failedCount).toBe(4);
    expect(dashboard.rows.map((row) => row.clipId)).toEqual(failedIds.slice(0, 2));
  });

  it("clamps a limit above the hard cap of 50 rather than returning more rows", async () => {
    const now = new Date();
    const horizon = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    const clipId = await createClip("limit-clamp", "approved");
    const publicationId = await createPublication(clipId);
    await createAttempt(clipId, publicationId, { trigger: "immediate", status: "failed" });

    const dashboard = await getCadencePublishingDashboard({ now, horizon, limit: 500 }, db);

    expect(dashboard.rows.length).toBeLessThanOrEqual(50);
    expect(dashboard.rows.map((row) => row.clipId)).toContain(clipId);
  });

  it("returns an empty dashboard with zeroed metrics when nothing is approved or published", async () => {
    const now = new Date();
    const horizon = new Date(now.getTime() + 60 * 60 * 1000);

    const dashboard = await getCadencePublishingDashboard({ now, horizon }, db);

    expect(dashboard.rows).toEqual([]);
    expect(dashboard.totalCount).toBe(0);
    expect(dashboard.metrics.nextDueAt).toBeNull();
    expect(dashboard.metrics).toMatchObject({
      upcomingScheduledCount: 0,
      approvedUnscheduledCount: 0,
      overdueCount: 0,
      failedCount: 0,
      manualReviewCount: 0,
      processingCount: 0,
      cleanupFailedCount: 0,
      collaborationFollowUpCount: 0,
      unverifiedCount: 0,
      postPublishFollowUpCount: 0,
      operatorAttentionCount: 0,
    });
  });

  it("hydrates queue rows with the same publishing state exposed by getPublishingStatesForClipIds", async () => {
    const now = new Date();
    const horizon = new Date(now.getTime() + 60 * 60 * 1000);
    const clipId = await createClip("hydration-check", "approved");
    const publicationId = await createPublication(clipId, {
      instagramPublishStatus: "failed",
    });
    await createAttempt(clipId, publicationId, { trigger: "immediate", status: "failed" });

    const dashboard = await getCadencePublishingDashboard({ now, horizon }, db);
    const row = dashboard.rows.find((entry) => entry.clipId === clipId);

    expect(row).toBeDefined();
    expect(row?.publishing.publicationId).toBe(publicationId);
    expect(row?.publishing.instagramPublishStatus).toBe("failed");
    expect(row?.publishing.scheduleStatus).toBe("failed");
  });
});

describe("getInsightsForClip", () => {
  it("returns an all-null empty state when the clip has no insights row yet", async () => {
    const clipId = await createClip("insights-empty", "published");

    const insights = await getInsightsForClip(clipId, db);

    expect(insights).toEqual({
      instagramInsightsFetchedAt: null,
      instagramViews: null,
      instagramReach: null,
      instagramLikes: null,
      instagramComments: null,
      instagramShares: null,
      instagramSaved: null,
      instagramInsightsError: null,
      facebookInsightsFetchedAt: null,
      facebookVideoViews: null,
      facebookReactions: null,
      facebookComments: null,
      facebookShares: null,
      facebookInsightsError: null,
    });
  });

  it("returns the stored metrics for a clip with an insights row", async () => {
    const clipId = await createClip("insights-populated", "published");
    const fetchedAt = new Date("2026-08-15T00:00:00.000Z");
    await db.insert(clipPublicationInsights).values({
      clipId,
      instagramInsightsFetchedAt: fetchedAt,
      instagramViews: 42,
      instagramReach: 30,
      instagramLikes: null,
      facebookInsightsError: "Meta rejected the insights request (code 100).",
    });

    const insights = await getInsightsForClip(clipId, db);

    expect(insights.instagramInsightsFetchedAt?.toISOString()).toBe(fetchedAt.toISOString());
    expect(insights.instagramViews).toBe(42);
    expect(insights.instagramReach).toBe(30);
    expect(insights.instagramLikes).toBeNull();
    expect(insights.facebookInsightsError).toBe(
      "Meta rejected the insights request (code 100).",
    );
    expect(insights.facebookVideoViews).toBeNull();
  });
});
