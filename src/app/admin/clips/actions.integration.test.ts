import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db } from "@/db/client";
import * as schema from "@/db/schema";
import { clipPublications, clips, publicationAttempts, type ClipStatus } from "@/db/schema";

function requireTestDatabaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL?.trim();
  if (!value) {
    throw new Error(
      "TEST_DATABASE_URL is required for admin clips action integration tests. Use a disposable database only.",
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
// approveClip/rejectClip call the module-level getDb() singleton directly
// (no injectable db), so it must resolve to the disposable test database
// before actions.ts is ever imported.
process.env.DATABASE_URL = testDatabaseUrl;

const requireSession = vi.fn();
vi.mock("@/lib/auth/require-session", () => ({ requireSession }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const verifyPublishedMedia = vi.fn();
vi.mock("@/lib/meta/instagram", () => ({ verifyPublishedMedia }));
const verifyPublishedVideo = vi.fn();
vi.mock("@/lib/meta/facebook", () => ({ verifyPublishedVideo }));

const sqlClient = postgres(testDatabaseUrl, { max: 8, prepare: false, connect_timeout: 15 });
const db: Db = drizzle(sqlClient, { schema });
const fixtureClipIds = new Set<string>();
const runId = randomUUID();
const targets = {
  instagramUserId: `actions-ig-${runId}`,
  facebookPageId: `actions-fb-${runId}`,
};

async function cleanupFixtures(): Promise<void> {
  const ids = [...fixtureClipIds];
  fixtureClipIds.clear();
  if (ids.length > 0) await db.delete(clips).where(inArray(clips.id, ids));
}

async function createClip(label: string, status: ClipStatus): Promise<string> {
  const id = randomUUID();
  const twitchClipId = `actions-${runId}-${label}-${id}`;
  fixtureClipIds.add(id);
  await db.insert(clips).values({
    id,
    twitchClipId,
    broadcasterId: `actions-broadcaster-${runId}`,
    title: `Actions fixture ${label}`,
    creatorName: "Actions Test",
    url: `https://clips.twitch.tv/${twitchClipId}`,
    embedUrl: `https://clips.twitch.tv/embed?clip=${twitchClipId}`,
    thumbnailUrl: `https://static-cdn.jtvnw.net/actions/${id}.jpg`,
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

async function attachActiveAttempt(
  clipId: string,
  status: "scheduled" | "processing" | "manual_review",
): Promise<void> {
  const [publication] = await db
    .insert(clipPublications)
    .values({ clipId })
    .returning();
  if (!publication) throw new Error("Could not create publication fixture.");
  const common = {
    clipId,
    publicationId: publication.id,
    authorizedAt: new Date(),
    authorizedCaption: "Actions integration authorization snapshot.",
    authorizedInstagramUserId: targets.instagramUserId,
    authorizedFacebookPageId: targets.facebookPageId,
  };
  if (status === "scheduled") {
    await db.insert(publicationAttempts).values({
      ...common,
      trigger: "scheduled",
      status: "scheduled",
      scheduledFor: new Date(Date.now() + 3_600_000),
    });
  } else if (status === "processing") {
    await db.insert(publicationAttempts).values({
      ...common,
      trigger: "immediate",
      status: "processing",
      claimToken: randomUUID(),
      claimedAt: new Date(),
      lockedUntil: new Date(Date.now() + 60_000),
    });
  } else {
    await db.insert(publicationAttempts).values({
      ...common,
      trigger: "immediate",
      status: "manual_review",
      completedAt: new Date(),
    });
  }
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
beforeEach(() => {
  requireSession.mockReset();
  requireSession.mockResolvedValue(undefined);
  verifyPublishedMedia.mockReset();
  verifyPublishedVideo.mockReset();
});
afterEach(cleanupFixtures);
afterAll(async () => {
  await cleanupFixtures();
  await sqlClient.end({ timeout: 5 });
});

function formDataWithId(id: string): FormData {
  const formData = new FormData();
  formData.set("id", id);
  return formData;
}

async function createManualReviewFixture(
  label: string,
  overrides: {
    instagramPublishStatus?: (typeof clipPublications.$inferInsert)["instagramPublishStatus"];
    facebookPublishStatus?: (typeof clipPublications.$inferInsert)["facebookPublishStatus"];
    attemptStatus?: "manual_review" | "processing";
  } = {},
): Promise<{ clipId: string; publicationId: string; attemptId: string }> {
  const clipId = await createClip(label, "approved");
  const [publication] = await db
    .insert(clipPublications)
    .values({
      clipId,
      instagramPublishStatus: overrides.instagramPublishStatus ?? "manual_review",
      facebookPublishStatus: overrides.facebookPublishStatus ?? "manual_review",
    })
    .returning();
  if (!publication) throw new Error("Could not create publication fixture.");
  const common = {
    clipId,
    publicationId: publication.id,
    trigger: "immediate" as const,
    authorizedAt: new Date(),
    authorizedCaption: "Actions integration authorization snapshot.",
    authorizedInstagramUserId: targets.instagramUserId,
    authorizedFacebookPageId: targets.facebookPageId,
  };
  const [attempt] =
    (overrides.attemptStatus ?? "manual_review") === "processing"
      ? await db
          .insert(publicationAttempts)
          .values({
            ...common,
            status: "processing",
            claimToken: randomUUID(),
            claimedAt: new Date(),
            lockedUntil: new Date(Date.now() + 60_000),
          })
          .returning()
      : await db
          .insert(publicationAttempts)
          .values({ ...common, status: "manual_review", completedAt: new Date() })
          .returning();
  if (!attempt) throw new Error("Could not create publication attempt fixture.");
  return { clipId, publicationId: publication.id, attemptId: attempt.id };
}

function platformReviewFormData(
  id: string,
  platform: "instagram" | "facebook",
  resolution: "published" | "retryable_failed",
  externalId?: string,
): FormData {
  const formData = new FormData();
  formData.set("id", id);
  formData.set("platform", platform);
  formData.set("resolution", resolution);
  if (externalId) formData.set("externalId", externalId);
  return formData;
}

function scheduleReviewFormData(
  id: string,
  resolution: "cancelled" | "retryable_failed",
): FormData {
  const formData = new FormData();
  formData.set("id", id);
  formData.set("resolution", resolution);
  return formData;
}

describe("approveClip", () => {
  it("approves a shortlisted clip with no active attempt", async () => {
    const { approveClip } = await import("./actions");
    const id = await createClip("approve-ok", "shortlisted");

    await approveClip(formDataWithId(id));

    const [stored] = await db.select().from(clips).where(inArray(clips.id, [id]));
    expect(stored?.status).toBe("approved");
    expect(stored?.approvedAt).toBeInstanceOf(Date);
  });

  it("refuses to re-approve a clip that is already approved (frozen editorial state)", async () => {
    const { approveClip } = await import("./actions");
    const id = await createClip("approve-frozen", "approved");

    await expect(approveClip(formDataWithId(id))).rejects.toThrow(
      "This clip can no longer be approved from its current state.",
    );

    const [stored] = await db.select().from(clips).where(inArray(clips.id, [id]));
    expect(stored?.status).toBe("approved");
  });

  it("refuses to approve a rejected clip", async () => {
    const { approveClip } = await import("./actions");
    const id = await createClip("approve-rejected", "rejected");

    await expect(approveClip(formDataWithId(id))).rejects.toThrow(
      "This clip can no longer be approved from its current state.",
    );
  });

  it("refuses to approve a clip that already has an active publish attempt", async () => {
    const { approveClip } = await import("./actions");
    const id = await createClip("approve-active-attempt", "shortlisted");
    await attachActiveAttempt(id, "manual_review");

    await expect(approveClip(formDataWithId(id))).rejects.toThrow(
      "This clip can no longer be approved from its current state.",
    );

    const [stored] = await db.select().from(clips).where(inArray(clips.id, [id]));
    expect(stored?.status).toBe("shortlisted");
  });
});

describe("rejectClip", () => {
  it("rejects a discovered clip with no active attempt", async () => {
    const { rejectClip } = await import("./actions");
    const id = await createClip("reject-ok", "discovered");

    await rejectClip(formDataWithId(id));

    const [stored] = await db.select().from(clips).where(inArray(clips.id, [id]));
    expect(stored?.status).toBe("rejected");
  });

  it("refuses to reject a clip that is already approved (frozen editorial state)", async () => {
    const { rejectClip } = await import("./actions");
    const id = await createClip("reject-frozen", "approved");

    await expect(rejectClip(formDataWithId(id))).rejects.toThrow(
      "This clip can no longer be rejected from its current state.",
    );

    const [stored] = await db.select().from(clips).where(inArray(clips.id, [id]));
    expect(stored?.status).toBe("approved");
  });

  it("refuses to reject an already-rejected clip", async () => {
    const { rejectClip } = await import("./actions");
    const id = await createClip("reject-already", "rejected");

    await expect(rejectClip(formDataWithId(id))).rejects.toThrow(
      "This clip can no longer be rejected from its current state.",
    );
  });

  it("refuses to reject a clip that already has an active publish attempt", async () => {
    const { rejectClip } = await import("./actions");
    const id = await createClip("reject-active-attempt", "shortlisted");
    await attachActiveAttempt(id, "scheduled");

    await expect(rejectClip(formDataWithId(id))).rejects.toThrow(
      "This clip can no longer be rejected from its current state.",
    );

    const [stored] = await db.select().from(clips).where(inArray(clips.id, [id]));
    expect(stored?.status).toBe("shortlisted");
  });
});

describe("resolvePlatformPublishReview", () => {
  it("rejects an externalId that isn't numeric before touching Meta or the database", async () => {
    const { resolvePlatformPublishReview } = await import("./actions");
    const { clipId } = await createManualReviewFixture("platform-review-bad-id");

    const result = await resolvePlatformPublishReview(
      { status: "idle" },
      platformReviewFormData(clipId, "instagram", "published", "not-numeric"),
    );

    expect(result).toEqual({
      status: "error",
      message: "Enter the confirmed numeric platform post ID.",
    });
    expect(verifyPublishedMedia).not.toHaveBeenCalled();
  });

  it("returns a soft error when the attempt is no longer awaiting manual review", async () => {
    const { resolvePlatformPublishReview } = await import("./actions");
    const { clipId } = await createManualReviewFixture("platform-review-stale", {
      attemptStatus: "processing",
    });

    const result = await resolvePlatformPublishReview(
      { status: "idle" },
      platformReviewFormData(clipId, "instagram", "retryable_failed"),
    );

    expect(result).toEqual({
      status: "error",
      message: "This platform is no longer awaiting manual review.",
    });
  });

  it("leaves the review state unchanged when Meta verification fails", async () => {
    const { resolvePlatformPublishReview } = await import("./actions");
    const { clipId, publicationId } = await createManualReviewFixture("platform-review-verify-fail");
    verifyPublishedMedia.mockRejectedValueOnce(
      new Error("Instagram media verification returned a different owner"),
    );

    const result = await resolvePlatformPublishReview(
      { status: "idle" },
      platformReviewFormData(clipId, "instagram", "published", "17800000000000001"),
    );

    expect(result.status).toBe("error");
    expect(result).toMatchObject({
      message: expect.stringContaining("The review state was not changed."),
    });
    const [publication] = await db
      .select()
      .from(clipPublications)
      .where(eq(clipPublications.id, publicationId));
    expect(publication?.instagramPublishStatus).toBe("manual_review");
  });

  it("resolves a single platform as retryable_failed and keeps the attempt in manual_review while the other platform is unresolved", async () => {
    const { resolvePlatformPublishReview } = await import("./actions");
    const { clipId, publicationId, attemptId } = await createManualReviewFixture(
      "platform-review-partial",
    );

    const result = await resolvePlatformPublishReview(
      { status: "idle" },
      platformReviewFormData(clipId, "instagram", "retryable_failed"),
    );

    expect(result).toEqual({ status: "ok", message: "Manual review recorded." });
    const [publication] = await db
      .select()
      .from(clipPublications)
      .where(eq(clipPublications.id, publicationId));
    expect(publication?.instagramPublishStatus).toBe("failed");
    expect(publication?.facebookPublishStatus).toBe("manual_review");
    const [attempt] = await db
      .select()
      .from(publicationAttempts)
      .where(eq(publicationAttempts.id, attemptId));
    expect(attempt?.status).toBe("manual_review");
    const [clip] = await db.select().from(clips).where(inArray(clips.id, [clipId]));
    expect(clip?.status).toBe("approved");
  });

  it("marks the attempt failed once both platforms resolve without a published outcome", async () => {
    const { resolvePlatformPublishReview } = await import("./actions");
    const { clipId, publicationId, attemptId } = await createManualReviewFixture(
      "platform-review-both-failed",
      { instagramPublishStatus: "failed" },
    );

    const result = await resolvePlatformPublishReview(
      { status: "idle" },
      platformReviewFormData(clipId, "facebook", "retryable_failed"),
    );

    expect(result).toEqual({ status: "ok", message: "Manual review recorded." });
    const [attempt] = await db
      .select()
      .from(publicationAttempts)
      .where(eq(publicationAttempts.id, attemptId));
    expect(attempt?.status).toBe("failed");
    const [publication] = await db
      .select()
      .from(clipPublications)
      .where(eq(clipPublications.id, publicationId));
    expect(publication?.facebookPublishStatus).toBe("failed");
  });

  it("verifies with Meta, records the permalink, and flips the clip to published once both platforms are confirmed", async () => {
    const { resolvePlatformPublishReview } = await import("./actions");
    const { clipId, publicationId, attemptId } = await createManualReviewFixture(
      "platform-review-complete",
      { instagramPublishStatus: "published" },
    );
    verifyPublishedVideo.mockResolvedValueOnce("https://facebook.com/permalink/complete");

    const result = await resolvePlatformPublishReview(
      { status: "idle" },
      platformReviewFormData(clipId, "facebook", "published", "17800000000000002"),
    );

    expect(verifyPublishedVideo).toHaveBeenCalledWith("17800000000000002", targets.facebookPageId);
    expect(result).toEqual({
      status: "ok",
      message: "Manual review recorded; both posts are now confirmed.",
    });
    const [publication] = await db
      .select()
      .from(clipPublications)
      .where(eq(clipPublications.id, publicationId));
    expect(publication?.facebookPublishStatus).toBe("published");
    expect(publication?.facebookPostId).toBe("17800000000000002");
    expect(publication?.facebookPermalink).toBe("https://facebook.com/permalink/complete");
    const [attempt] = await db
      .select()
      .from(publicationAttempts)
      .where(eq(publicationAttempts.id, attemptId));
    expect(attempt?.status).toBe("completed");
    const [clip] = await db.select().from(clips).where(inArray(clips.id, [clipId]));
    expect(clip?.status).toBe("published");
    expect(clip?.publishedAt).toBeInstanceOf(Date);
  });
});

describe("resolveSchedulePublishReview", () => {
  it("rejects an invalid resolution value", async () => {
    const { resolveSchedulePublishReview } = await import("./actions");
    const { clipId } = await createManualReviewFixture("schedule-review-bad-resolution");
    const formData = new FormData();
    formData.set("id", clipId);
    formData.set("resolution", "published");

    const result = await resolveSchedulePublishReview({ status: "idle" }, formData);

    expect(result).toEqual({
      status: "error",
      message: "Choose cancel or clear for a new authorization.",
    });
  });

  it("returns a soft error when the attempt is no longer in review", async () => {
    const { resolveSchedulePublishReview } = await import("./actions");
    const { clipId } = await createManualReviewFixture("schedule-review-stale", {
      attemptStatus: "processing",
    });

    const result = await resolveSchedulePublishReview(
      { status: "idle" },
      scheduleReviewFormData(clipId, "cancelled"),
    );

    expect(result).toEqual({
      status: "error",
      message: "This publish authorization is no longer in review.",
    });
  });

  it("refuses to clear the schedule review while a platform outcome is still ambiguous", async () => {
    const { resolveSchedulePublishReview } = await import("./actions");
    const { clipId, attemptId } = await createManualReviewFixture("schedule-review-ambiguous");

    const result = await resolveSchedulePublishReview(
      { status: "idle" },
      scheduleReviewFormData(clipId, "retryable_failed"),
    );

    expect(result).toEqual({
      status: "error",
      message: "Resolve each ambiguous platform outcome before clearing this schedule review.",
    });
    const [attempt] = await db
      .select()
      .from(publicationAttempts)
      .where(eq(publicationAttempts.id, attemptId));
    expect(attempt?.status).toBe("manual_review");
  });

  it("cancels the authorization once both platform outcomes are already resolved", async () => {
    const { resolveSchedulePublishReview } = await import("./actions");
    const { clipId, attemptId } = await createManualReviewFixture("schedule-review-cancel", {
      instagramPublishStatus: "failed",
      facebookPublishStatus: "failed",
    });

    const result = await resolveSchedulePublishReview(
      { status: "idle" },
      scheduleReviewFormData(clipId, "cancelled"),
    );

    expect(result).toEqual({ status: "ok", message: "Publish authorization cancelled." });
    const [attempt] = await db
      .select()
      .from(publicationAttempts)
      .where(eq(publicationAttempts.id, attemptId));
    expect(attempt?.status).toBe("cancelled");
    expect(attempt?.error).toBeNull();
  });

  it("clears a resolved schedule review as retryable_failed with an explanatory error", async () => {
    const { resolveSchedulePublishReview } = await import("./actions");
    const { clipId, attemptId } = await createManualReviewFixture("schedule-review-clear", {
      instagramPublishStatus: "published",
      facebookPublishStatus: "failed",
    });

    const result = await resolveSchedulePublishReview(
      { status: "idle" },
      scheduleReviewFormData(clipId, "retryable_failed"),
    );

    expect(result).toEqual({
      status: "ok",
      message: "Review cleared; a new Publish or Schedule Publish click is required.",
    });
    const [attempt] = await db
      .select()
      .from(publicationAttempts)
      .where(eq(publicationAttempts.id, attemptId));
    expect(attempt?.status).toBe("failed");
    expect(attempt?.error).toBe("Manually inspected and cleared for a new explicit authorization.");
  });
});
