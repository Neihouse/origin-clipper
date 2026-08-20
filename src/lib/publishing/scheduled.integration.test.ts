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

vi.mock("./core", () => ({
  claimNextDueScheduledPublish: vi.fn(),
  publishClaimedClip: vi.fn(),
  markActiveClaimForManualReview: vi.fn(),
}));

import {
  claimNextDueScheduledPublish,
  publishClaimedClip,
  markActiveClaimForManualReview,
} from "./core";
import {
  reconcileExpiredClaims,
  quarantineInvalidDueSchedules,
  runDueScheduledPublishes,
} from "./scheduled";

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
  instagramUserId: `scheduled-ig-${runId}`,
  facebookPageId: `scheduled-fb-${runId}`,
};

async function cleanupFixtures(): Promise<void> {
  const ids = [...fixtureClipIds];
  fixtureClipIds.clear();
  if (ids.length > 0) await db.delete(clips).where(inArray(clips.id, ids));
}

async function createClip(
  label: string,
  status: (typeof clips.$inferInsert)["status"] = "approved",
): Promise<string> {
  const id = randomUUID();
  const twitchClipId = `scheduled-${runId}-${label}-${id}`;
  fixtureClipIds.add(id);
  await db.insert(clips).values({
    id,
    twitchClipId,
    broadcasterId: `scheduled-broadcaster-${runId}`,
    title: `Scheduled fixture ${label}`,
    creatorName: "Integration Test",
    url: `https://clips.twitch.tv/${twitchClipId}`,
    embedUrl: `https://clips.twitch.tv/embed?clip=${twitchClipId}`,
    thumbnailUrl: `https://static-cdn.jtvnw.net/scheduled/${id}.jpg`,
    viewCount: 0,
    durationSeconds: 30,
    clipCreatedAt: new Date(),
    streamDate: "2026-08-20",
    status,
    approvedAt: status === "approved" ? new Date() : null,
    proposedCaption: `A scheduled-worker field note with ${label}.`,
  });
  return id;
}

async function createPublication(
  clipId: string,
  overrides: Partial<typeof clipPublications.$inferInsert> = {},
) {
  const [row] = await db
    .insert(clipPublications)
    .values({ clipId, ...overrides })
    .returning();
  if (!row) throw new Error("Could not create publication fixture.");
  return row;
}

async function createAttempt(
  clipId: string,
  publicationId: string,
  overrides: Partial<typeof publicationAttempts.$inferInsert>,
) {
  const [row] = await db
    .insert(publicationAttempts)
    .values({
      clipId,
      publicationId,
      trigger: "immediate",
      status: "scheduled",
      authorizedAt: new Date(),
      authorizedCaption: "Scheduled-worker integration authorization snapshot.",
      authorizedInstagramUserId: targets.instagramUserId,
      authorizedFacebookPageId: targets.facebookPageId,
      ...overrides,
    })
    .returning();
  if (!row) throw new Error("Could not create publication attempt fixture.");
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

async function loadPublication(publicationId: string) {
  const [row] = await db
    .select()
    .from(clipPublications)
    .where(eq(clipPublications.id, publicationId));
  if (!row) throw new Error("Fixture publication row is missing.");
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
  vi.mocked(claimNextDueScheduledPublish).mockReset();
  vi.mocked(publishClaimedClip).mockReset();
  vi.mocked(markActiveClaimForManualReview).mockReset();
});

afterEach(cleanupFixtures);
afterAll(async () => {
  await cleanupFixtures();
  await sqlClient.end({ timeout: 5 });
});

describe("reconcileExpiredClaims", () => {
  it("completes an expired processing attempt once both platforms are published", async () => {
    const clipId = await createClip("expired-both-published");
    const publication = await createPublication(clipId, {
      instagramPublishStatus: "published",
      facebookPublishStatus: "published",
    });
    const attempt = await createAttempt(clipId, publication.id, {
      status: "processing",
      claimToken: randomUUID(),
      claimedAt: new Date(Date.now() - 120_000),
      lockedUntil: new Date(Date.now() - 60_000),
    });

    const result = await reconcileExpiredClaims({ db });

    expect(result.alreadyComplete).toBe(1);
    expect(result.stale).toBe(0);

    const reloadedAttempt = await loadAttempt(attempt.id);
    expect(reloadedAttempt.status).toBe("completed");
    expect(reloadedAttempt.lockedUntil).toBeNull();
    expect(reloadedAttempt.completedAt).toBeInstanceOf(Date);

    const reloadedClip = await loadClip(clipId);
    expect(reloadedClip.status).toBe("published");
    expect(reloadedClip.publishedAt).toBeInstanceOf(Date);
  });

  it("marks an expired processing attempt manual_review when a platform is still pending", async () => {
    const clipId = await createClip("expired-pending-platform");
    const publication = await createPublication(clipId, {
      instagramPublishStatus: "pending",
      facebookPublishStatus: "published",
    });
    const attempt = await createAttempt(clipId, publication.id, {
      status: "processing",
      claimToken: randomUUID(),
      claimedAt: new Date(Date.now() - 120_000),
      lockedUntil: new Date(Date.now() - 60_000),
    });

    const result = await reconcileExpiredClaims({ db });

    expect(result.alreadyComplete).toBe(0);
    expect(result.stale).toBe(1);

    const reloadedAttempt = await loadAttempt(attempt.id);
    expect(reloadedAttempt.status).toBe("manual_review");
    expect(reloadedAttempt.error).toBe(
      "A publishing attempt timed out. Inspect both platforms before retrying.",
    );
    expect(reloadedAttempt.lockedUntil).toBeNull();

    const reloadedPublication = await loadPublication(publication.id);
    expect(reloadedPublication.instagramPublishStatus).toBe("manual_review");
    expect(reloadedPublication.facebookPublishStatus).toBe("published");

    const reloadedClip = await loadClip(clipId);
    expect(reloadedClip.status).toBe("approved");
  });

  it("leaves a still-locked processing attempt untouched", async () => {
    const clipId = await createClip("still-locked");
    const publication = await createPublication(clipId, {
      instagramPublishStatus: "published",
      facebookPublishStatus: "published",
    });
    const attempt = await createAttempt(clipId, publication.id, {
      status: "processing",
      claimToken: randomUUID(),
      claimedAt: new Date(),
      lockedUntil: new Date(Date.now() + 60_000),
    });

    const result = await reconcileExpiredClaims({ db });

    expect(result.alreadyComplete).toBe(0);
    expect(result.stale).toBe(0);

    const reloadedAttempt = await loadAttempt(attempt.id);
    expect(reloadedAttempt.status).toBe("processing");
    expect(reloadedAttempt.lockedUntil).toBeInstanceOf(Date);

    const reloadedClip = await loadClip(clipId);
    expect(reloadedClip.status).toBe("approved");
  });
});

describe("quarantineInvalidDueSchedules", () => {
  it("quarantines a scheduled attempt whose clip is no longer approved", async () => {
    const clipId = await createClip("no-longer-approved", "rejected");
    const publication = await createPublication(clipId);
    const attempt = await createAttempt(clipId, publication.id, {
      trigger: "scheduled",
      status: "scheduled",
      scheduledFor: new Date(Date.now() - 60_000),
    });

    const count = await quarantineInvalidDueSchedules({ db });

    expect(count).toBe(1);
    const reloadedAttempt = await loadAttempt(attempt.id);
    expect(reloadedAttempt.status).toBe("manual_review");
    expect(reloadedAttempt.error).toBe(
      "The scheduled publish authorization or platform state is incomplete.",
    );
    expect(reloadedAttempt.completedAt).toBeInstanceOf(Date);
  });

  it("quarantines a scheduled attempt with an ambiguous platform status and flips pending to manual_review", async () => {
    const clipId = await createClip("ambiguous-platform");
    const publication = await createPublication(clipId, {
      instagramPublishStatus: "pending",
    });
    const attempt = await createAttempt(clipId, publication.id, {
      trigger: "scheduled",
      status: "scheduled",
      scheduledFor: new Date(Date.now() - 60_000),
    });

    const count = await quarantineInvalidDueSchedules({ db });

    expect(count).toBe(1);
    const reloadedAttempt = await loadAttempt(attempt.id);
    expect(reloadedAttempt.status).toBe("manual_review");

    const reloadedPublication = await loadPublication(publication.id);
    expect(reloadedPublication.instagramPublishStatus).toBe("manual_review");
    expect(reloadedPublication.facebookPublishStatus).toBe("not_started");
  });

  it("leaves a clean due schedule alone", async () => {
    const clipId = await createClip("clean-due-schedule");
    const publication = await createPublication(clipId);
    const attempt = await createAttempt(clipId, publication.id, {
      trigger: "scheduled",
      status: "scheduled",
      scheduledFor: new Date(Date.now() - 60_000),
    });

    const count = await quarantineInvalidDueSchedules({ db });

    expect(count).toBe(0);
    const reloadedAttempt = await loadAttempt(attempt.id);
    expect(reloadedAttempt.status).toBe("scheduled");
  });
});

describe("runDueScheduledPublishes", () => {
  it("rejects a limit outside 1..SCHEDULED_PUBLISH_BATCH_SIZE without touching the db", async () => {
    await expect(runDueScheduledPublishes(2, { db })).rejects.toThrow(
      "Scheduled publish batch limit must be 1-1.",
    );
    await expect(runDueScheduledPublishes(0, { db })).rejects.toThrow(
      "Scheduled publish batch limit must be 1-1.",
    );
    expect(claimNextDueScheduledPublish).not.toHaveBeenCalled();
  });

  it("reflects real reconcile/quarantine work even when nothing is claimable", async () => {
    const clipId = await createClip("summary-stale-fixture");
    const publication = await createPublication(clipId, {
      instagramPublishStatus: "published",
      facebookPublishStatus: "pending",
    });
    await createAttempt(clipId, publication.id, {
      status: "processing",
      claimToken: randomUUID(),
      claimedAt: new Date(Date.now() - 120_000),
      lockedUntil: new Date(Date.now() - 60_000),
    });
    vi.mocked(claimNextDueScheduledPublish).mockResolvedValue(null);

    const summary = await runDueScheduledPublishes(undefined, { db });

    expect(summary.stale).toBe(1);
    expect(summary.alreadyComplete).toBe(0);
    expect(summary.invalid).toBe(0);
    expect(summary.claimed).toBe(0);
    expect(claimNextDueScheduledPublish).toHaveBeenCalledTimes(1);
    expect(publishClaimedClip).not.toHaveBeenCalled();
  });

  it("bumps completed when the claimed publish reports scheduleStatus completed", async () => {
    const claim = {
      attemptId: randomUUID(),
      clipId: randomUUID(),
      publicationId: randomUUID(),
      claimToken: randomUUID(),
    };
    vi.mocked(claimNextDueScheduledPublish).mockResolvedValueOnce(claim).mockResolvedValue(null);
    vi.mocked(publishClaimedClip).mockResolvedValue({
      instagram: { status: "published" },
      facebook: { status: "published" },
      allPublished: true,
      scheduleStatus: "completed",
    });

    const summary = await runDueScheduledPublishes(undefined, { db });

    expect(summary.claimed).toBe(1);
    expect(summary.completed).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.manualReview).toBe(0);
    expect(publishClaimedClip).toHaveBeenCalledWith(claim, { db });
    expect(markActiveClaimForManualReview).not.toHaveBeenCalled();
  });

  it("bumps failed when the claimed publish reports scheduleStatus failed", async () => {
    const claim = {
      attemptId: randomUUID(),
      clipId: randomUUID(),
      publicationId: randomUUID(),
      claimToken: randomUUID(),
    };
    vi.mocked(claimNextDueScheduledPublish).mockResolvedValueOnce(claim).mockResolvedValue(null);
    vi.mocked(publishClaimedClip).mockResolvedValue({
      instagram: { status: "failed", error: "boom" },
      facebook: { status: "published" },
      allPublished: false,
      scheduleStatus: "failed",
    });

    const summary = await runDueScheduledPublishes(undefined, { db });

    expect(summary.claimed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.completed).toBe(0);
    expect(summary.manualReview).toBe(0);
  });

  it("bumps manualReview when the claimed publish reports scheduleStatus manual_review", async () => {
    const claim = {
      attemptId: randomUUID(),
      clipId: randomUUID(),
      publicationId: randomUUID(),
      claimToken: randomUUID(),
    };
    vi.mocked(claimNextDueScheduledPublish).mockResolvedValueOnce(claim).mockResolvedValue(null);
    vi.mocked(publishClaimedClip).mockResolvedValue({
      instagram: { status: "manual_review", error: "ambiguous" },
      facebook: { status: "published" },
      allPublished: false,
      scheduleStatus: "manual_review",
    });

    const summary = await runDueScheduledPublishes(undefined, { db });

    expect(summary.claimed).toBe(1);
    expect(summary.manualReview).toBe(1);
    expect(summary.completed).toBe(0);
    expect(summary.failed).toBe(0);
  });

  it("marks the claim for manual review when publishClaimedClip throws and the marker succeeds", async () => {
    const claim = {
      attemptId: randomUUID(),
      clipId: randomUUID(),
      publicationId: randomUUID(),
      claimToken: randomUUID(),
    };
    vi.mocked(claimNextDueScheduledPublish).mockResolvedValueOnce(claim).mockResolvedValue(null);
    vi.mocked(publishClaimedClip).mockRejectedValue(new Error("network blip"));
    vi.mocked(markActiveClaimForManualReview).mockResolvedValue(true);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const summary = await runDueScheduledPublishes(undefined, { db });

    expect(summary.claimed).toBe(1);
    expect(summary.manualReview).toBe(1);
    expect(summary.failed).toBe(0);
    expect(markActiveClaimForManualReview).toHaveBeenCalledWith(claim, undefined, { db });
    const loggedPayload = consoleError.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(loggedPayload).toMatchObject({
      clipId: claim.clipId,
      attemptId: claim.attemptId,
      name: "Error",
    });
    consoleError.mockRestore();
  });

  it("falls back to failed when publishClaimedClip throws and the marker returns false", async () => {
    const claim = {
      attemptId: randomUUID(),
      clipId: randomUUID(),
      publicationId: randomUUID(),
      claimToken: randomUUID(),
    };
    vi.mocked(claimNextDueScheduledPublish).mockResolvedValueOnce(claim).mockResolvedValue(null);
    vi.mocked(publishClaimedClip).mockRejectedValue(new Error("network blip"));
    vi.mocked(markActiveClaimForManualReview).mockResolvedValue(false);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const summary = await runDueScheduledPublishes(undefined, { db });

    expect(summary.claimed).toBe(1);
    expect(summary.manualReview).toBe(0);
    expect(summary.failed).toBe(1);
    consoleError.mockRestore();
  });
});
