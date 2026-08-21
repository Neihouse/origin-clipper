import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type Db } from "@/db/client";
import * as schema from "@/db/schema";
import { clipPublications, clips, publicationAttempts } from "@/db/schema";
import {
  claimNextBlobCleanup,
  reconcileStaleBlobCleanupClaims,
  runVerifiedBlobCleanup,
} from "./blob-cleanup";
import {
  authorizeScheduledPublish,
  cancelScheduledAttempt,
  claimImmediatePublish,
  claimNextDueScheduledPublish,
  rescheduleScheduledAttempt,
} from "./repository";
import { publishClaimedClip } from "./core";
import { reconcileExpiredClaims } from "./scheduled";

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
  max: 12,
  prepare: false,
  connect_timeout: 15,
});
const db: Db = drizzle(sqlClient, { schema });
const fixtureClipIds = new Set<string>();
const runId = randomUUID();
const targets = {
  instagramUserId: `integration-ig-${runId}`,
  facebookPageId: `integration-fb-${runId}`,
};

function nonNull<T>(value: T | null): value is T {
  return value !== null;
}

async function cleanupFixtures(): Promise<void> {
  const ids = [...fixtureClipIds];
  fixtureClipIds.clear();
  if (ids.length > 0) await db.delete(clips).where(inArray(clips.id, ids));
}

async function createApprovedClip(label: string): Promise<string> {
  const id = randomUUID();
  const twitchClipId = `integration-${runId}-${label}-${id}`;
  fixtureClipIds.add(id);
  await db.insert(clips).values({
    id,
    twitchClipId,
    broadcasterId: `integration-broadcaster-${runId}`,
    title: `Integration fixture ${label}`,
    creatorName: "Integration Test",
    url: `https://clips.twitch.tv/${twitchClipId}`,
    embedUrl: `https://clips.twitch.tv/embed?clip=${twitchClipId}`,
    thumbnailUrl: `https://static-cdn.jtvnw.net/integration/${id}.jpg`,
    viewCount: 0,
    durationSeconds: 30,
    clipCreatedAt: new Date(),
    streamDate: "2026-08-20",
    status: "approved",
    approvedAt: new Date(),
    proposedCaption: `An ORIGIN field note with ${label}.`,
  });
  return id;
}

async function createCleanupCandidate(
  label: string,
  overrides: {
    clipStatus?: (typeof clips.$inferInsert)["status"];
    publication?: Partial<typeof clipPublications.$inferInsert>;
  } = {},
) {
  const clipId = await createApprovedClip(label);
  await db
    .update(clips)
    .set({ status: overrides.clipStatus ?? "published", publishedAt: new Date() })
    .where(eq(clips.id, clipId));
  const assetId = randomUUID();
  const [publication] = await db
    .insert(clipPublications)
    .values({
      clipId,
      videoAssetUrl: `https://blob.example.test/clips/${assetId}.mp4`,
      videoAssetEtag: `etag-${assetId}`,
      videoAssetFetchedAt: new Date(Date.now() - 3 * 24 * 60 * 60_000),
      instagramPublishStatus: "published",
      instagramMediaId: `ig-${assetId}`,
      instagramPublishedAt: new Date(Date.now() - 3 * 24 * 60 * 60_000),
      facebookPublishStatus: "published",
      facebookPostId: `fb-${assetId}`,
      facebookPublishedAt: new Date(Date.now() - 3 * 24 * 60 * 60_000),
      publishVerifiedAt: new Date(Date.now() - 2 * 24 * 60 * 60_000),
      ...overrides.publication,
    })
    .returning();
  if (!publication) throw new Error("Could not create cleanup integration fixture.");
  return { clipId, publication };
}

async function assertDisposableDatabaseIsIdle(): Promise<void> {
  try {
    const probe = await db.execute(sql`
      SELECT
        to_regclass('public.clips')::text AS "clipsTable",
        to_regclass('public.clip_publications')::text AS "publicationsTable",
        to_regclass('public.publication_attempts')::text AS "attemptsTable"
    `);
    const row = (
      probe as unknown as Array<{
        clipsTable: string | null;
        publicationsTable: string | null;
        attemptsTable: string | null;
      }>
    )[0];
    if (!row?.clipsTable || !row.publicationsTable || !row.attemptsTable) throw new Error();
  } catch {
    throw new Error(
      "The disposable test database does not have the current schema. Apply migrations separately before running integration tests.",
    );
  }

  const hazards = await db.execute(sql`
    WITH hazards AS (
      SELECT 'due publication authorization' AS kind
      WHERE EXISTS (
        SELECT 1 FROM "publication_attempts"
        WHERE "status" = 'scheduled' AND "scheduled_for" <= now()
      )
      UNION ALL
      SELECT 'expired publication lease' AS kind
      WHERE EXISTS (
        SELECT 1 FROM "publication_attempts"
        WHERE "status" = 'processing'
          AND ("locked_until" IS NULL OR "locked_until" <= now())
      )
      UNION ALL
      SELECT 'stale Blob cleanup lease' AS kind
      WHERE EXISTS (
        SELECT 1 FROM "clip_publications"
        WHERE "blob_cleanup_status" = 'processing'
          AND "blob_cleanup_locked_until" <= now()
      )
      UNION ALL
      SELECT 'eligible Blob cleanup asset' AS kind
      WHERE EXISTS (
        SELECT 1
        FROM "clip_publications" AS publication
        INNER JOIN "clips" AS clip ON clip."id" = publication."clip_id"
        WHERE
          clip."status" = 'published'
          AND
          publication."video_asset_url" IS NOT NULL
          AND publication."video_asset_etag" IS NOT NULL
          AND publication."publish_verified_at" <= now() - interval '1 day'
          AND publication."instagram_publish_status" = 'published'
          AND publication."facebook_publish_status" = 'published'
          AND publication."blob_cleanup_status" IN ('retained', 'failed')
          AND NOT EXISTS (
            SELECT 1 FROM "publication_attempts" AS attempt
            WHERE attempt."publication_id" = publication."id"
              AND attempt."status" IN ('scheduled', 'processing', 'manual_review')
          )
      )
    )
    SELECT kind FROM hazards
  `);
  const kinds = (hazards as unknown as Array<{ kind: string }>).map((row) => row.kind);
  if (kinds.length > 0) {
    throw new Error(
      `TEST_DATABASE_URL must target an idle disposable database; pre-existing ${kinds.join(
        ", ",
      )} would be visible to global worker claims.`,
    );
  }
}

beforeAll(assertDisposableDatabaseIsIdle);
afterEach(cleanupFixtures);
afterAll(async () => {
  await cleanupFixtures();
  await sqlClient.end({ timeout: 5 });
});

describe("PostgreSQL publication authorization invariants", () => {
  it("gives concurrent due workers exactly one winner for one authorization", async () => {
    const clipId = await createApprovedClip("due-claim");
    const attempt = await authorizeScheduledPublish(
      clipId,
      new Date(Date.now() - 60_000),
      { db, targets },
    );
    expect(attempt).not.toBeNull();

    const claims = await Promise.all(
      Array.from({ length: 8 }, () => claimNextDueScheduledPublish({ db })),
    );
    const winners = claims.filter(nonNull);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.attemptId).toBe(attempt?.id);

    const [stored] = await db
      .select()
      .from(publicationAttempts)
      .where(eq(publicationAttempts.id, attempt!.id));
    expect(stored?.status).toBe("processing");
    expect(stored?.claimToken).toBe(winners[0]?.claimToken);
    expect(stored?.claimedAt).toBeInstanceOf(Date);
    expect(stored?.lockedUntil?.getTime()).toBeGreaterThan(Date.now());
  });

  it("turns concurrent immediate double-clicks into one active attempt", async () => {
    const clipId = await createApprovedClip("immediate-double-click");
    const claims = await Promise.all(
      Array.from({ length: 8 }, () => claimImmediatePublish(clipId, { db, targets })),
    );
    expect(claims.filter(nonNull)).toHaveLength(1);

    const attempts = await db
      .select()
      .from(publicationAttempts)
      .where(eq(publicationAttempts.clipId, clipId));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.trigger).toBe("immediate");
    expect(attempts[0]?.status).toBe("processing");
  });

  it("lets cancellation and claim race without resurrecting the cancelled authorization", async () => {
    const clipId = await createApprovedClip("cancel-claim-race");
    const attempt = await authorizeScheduledPublish(
      clipId,
      new Date(Date.now() - 60_000),
      { db, targets },
    );
    if (!attempt) throw new Error("Could not authorize cancellation-race fixture.");

    const [cancelled, claim] = await Promise.all([
      cancelScheduledAttempt(attempt.id, { db }),
      claimNextDueScheduledPublish({ db }),
    ]);
    expect(Number(cancelled) + Number(claim !== null)).toBe(1);

    const [stored] = await db
      .select()
      .from(publicationAttempts)
      .where(eq(publicationAttempts.id, attempt.id));
    expect(stored?.status).toBe(cancelled ? "cancelled" : "processing");
    if (cancelled) {
      expect(await claimNextDueScheduledPublish({ db })).toBeNull();
      expect(
        await rescheduleScheduledAttempt(attempt.id, new Date(Date.now() + 3_600_000), {
          db,
          targets,
        }),
      ).toBeNull();
    }
  });

  it("atomically replaces a schedule or loses to its claim without reviving the old row", async () => {
    const clipId = await createApprovedClip("reschedule-claim-race");
    const oldAttempt = await authorizeScheduledPublish(
      clipId,
      new Date(Date.now() - 60_000),
      { db, targets },
    );
    if (!oldAttempt) throw new Error("Could not authorize reschedule-race fixture.");
    const replacementTime = new Date(Date.now() + 3_600_000);

    const [replacement, claim] = await Promise.all([
      rescheduleScheduledAttempt(oldAttempt.id, replacementTime, { db, targets }),
      claimNextDueScheduledPublish({ db }),
    ]);
    expect(Number(replacement !== null) + Number(claim !== null)).toBe(1);

    const history = await db
      .select()
      .from(publicationAttempts)
      .where(eq(publicationAttempts.clipId, clipId));
    if (replacement) {
      expect(history).toHaveLength(2);
      expect(history.find((row) => row.id === oldAttempt.id)?.status).toBe("cancelled");
      expect(history.find((row) => row.id === replacement.id)?.status).toBe("scheduled");
      expect(await claimNextDueScheduledPublish({ db })).toBeNull();
    } else {
      expect(history).toHaveLength(1);
      expect(history[0]?.id).toBe(oldAttempt.id);
      expect(history[0]?.status).toBe("processing");
    }
  });

  it("fails an expired partial attempt closed while preserving the completed platform", async () => {
    const clipId = await createApprovedClip("expired-partial");
    const claim = await claimImmediatePublish(clipId, { db, targets });
    if (!claim) throw new Error("Could not claim expired-partial fixture.");
    const instagramPublishedAt = new Date(Date.now() - 60_000);
    await db
      .update(clipPublications)
      .set({
        instagramPublishStatus: "published",
        instagramMediaId: `ig-complete-${runId}`,
        instagramPermalink: "https://www.instagram.com/reel/integration",
        instagramPublishedAt,
        facebookPublishStatus: "pending",
      })
      .where(eq(clipPublications.id, claim.publicationId));
    await db
      .update(publicationAttempts)
      .set({ lockedUntil: new Date(Date.now() - 1_000) })
      .where(eq(publicationAttempts.id, claim.attemptId));

    await expect(publishClaimedClip(claim, { db, targets })).rejects.toThrow(
      "no longer the active attempt",
    );

    await expect(reconcileExpiredClaims({ db })).resolves.toEqual({
      stale: 1,
      alreadyComplete: 0,
    });

    const [attempt] = await db
      .select()
      .from(publicationAttempts)
      .where(eq(publicationAttempts.id, claim.attemptId));
    const [publication] = await db
      .select()
      .from(clipPublications)
      .where(eq(clipPublications.id, claim.publicationId));
    expect(attempt?.status).toBe("manual_review");
    expect(publication?.instagramPublishStatus).toBe("published");
    expect(publication?.instagramMediaId).toBe(`ig-complete-${runId}`);
    expect(publication?.instagramPublishedAt?.getTime()).toBe(instagramPublishedAt.getTime());
    expect(publication?.facebookPublishStatus).toBe("manual_review");
    expect(await claimImmediatePublish(clipId, { db, targets })).toBeNull();
  });

  it("rejects cross-wired publication ownership and incoherent attempt lifecycles", async () => {
    const firstClipId = await createApprovedClip("constraint-a");
    const secondClipId = await createApprovedClip("constraint-b");
    const [firstPublication] = await db
      .insert(clipPublications)
      .values({ clipId: firstClipId })
      .returning();
    const [secondPublication] = await db
      .insert(clipPublications)
      .values({ clipId: secondClipId })
      .returning();
    if (!firstPublication || !secondPublication) throw new Error("Could not create FK fixtures.");
    const common = {
      authorizedAt: new Date(),
      authorizedCaption: "Integration authorization snapshot.",
      authorizedInstagramUserId: targets.instagramUserId,
      authorizedFacebookPageId: targets.facebookPageId,
    };

    await expect(
      db.insert(publicationAttempts).values({
        clipId: firstClipId,
        publicationId: secondPublication.id,
        trigger: "scheduled",
        status: "scheduled",
        scheduledFor: new Date(Date.now() + 3_600_000),
        ...common,
      }),
    ).rejects.toThrow();

    await expect(
      db.insert(publicationAttempts).values({
        clipId: firstClipId,
        publicationId: firstPublication.id,
        trigger: "immediate",
        status: "failed",
        scheduledFor: new Date(Date.now() + 3_600_000),
        completedAt: new Date(),
        ...common,
      }),
    ).rejects.toThrow();

    await expect(
      db.insert(publicationAttempts).values({
        clipId: firstClipId,
        publicationId: firstPublication.id,
        trigger: "immediate",
        status: "failed",
        scheduledFor: null,
        completedAt: null,
        ...common,
      }),
    ).rejects.toThrow();
  });
});

describe("PostgreSQL Blob cleanup invariants", () => {
  it("gives concurrent cleanup workers exactly one lease", async () => {
    const { publication } = await createCleanupCandidate("cleanup-claim");
    const claims = await Promise.all(
      Array.from({ length: 8 }, () => claimNextBlobCleanup({ db, retentionDays: 1 })),
    );
    const winners = claims.filter(nonNull);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.publicationId).toBe(publication.id);
    expect(winners[0]?.videoAssetEtag).toBe(publication.videoAssetEtag);
  });

  it("fails a stale cleanup lease closed and does not reclaim it in the same run", async () => {
    const { publication } = await createCleanupCandidate("cleanup-stale");
    await db
      .update(clipPublications)
      .set({
        blobCleanupStatus: "processing",
        blobCleanupClaimToken: randomUUID(),
        blobCleanupLockedUntil: new Date(Date.now() - 1_000),
        blobCleanupAttemptedAt: new Date(),
      })
      .where(eq(clipPublications.id, publication.id));

    await expect(reconcileStaleBlobCleanupClaims(db)).resolves.toBe(1);
    await expect(claimNextBlobCleanup({ db, retentionDays: 1 })).resolves.toBeNull();

    const [stored] = await db
      .select()
      .from(clipPublications)
      .where(eq(clipPublications.id, publication.id));
    expect(stored?.blobCleanupStatus).toBe("failed");
    expect(stored?.blobCleanupClaimToken).toBeNull();
    expect(stored?.blobCleanupLockedUntil).toBeNull();
    expect(stored?.videoAssetUrl).toBe(publication.videoAssetUrl);
    expect(stored?.videoAssetEtag).toBe(publication.videoAssetEtag);
  });

  it("passes the exact ETag and clears the asset only after a successful conditional delete", async () => {
    const { publication } = await createCleanupCandidate("cleanup-success");
    const calls: Array<{ url: string; etag: string }> = [];

    await expect(
      runVerifiedBlobCleanup({
        db,
        retentionDays: 1,
        deleteAsset: async (url, etag) => {
          calls.push({ url, etag });
        },
      }),
    ).resolves.toEqual({ claimed: 1, deleted: 1, failed: 0, stale: 0 });
    expect(calls).toEqual([
      { url: publication.videoAssetUrl, etag: publication.videoAssetEtag },
    ]);

    const [stored] = await db
      .select()
      .from(clipPublications)
      .where(eq(clipPublications.id, publication.id));
    expect(stored?.blobCleanupStatus).toBe("deleted");
    expect(stored?.videoAssetUrl).toBeNull();
    expect(stored?.videoAssetEtag).toBeNull();
    expect(stored?.blobDeletedAt).toBeInstanceOf(Date);
  });

  it("cannot mark a replacement asset deleted with a stale cleanup claim", async () => {
    const { publication } = await createCleanupCandidate("cleanup-etag-race");
    const replacementUrl = `https://blob.example.test/clips/replacement-${runId}.mp4`;
    const replacementEtag = `replacement-etag-${runId}`;

    await expect(
      runVerifiedBlobCleanup({
        db,
        retentionDays: 1,
        deleteAsset: async () => {
          await db
            .update(clipPublications)
            .set({ videoAssetUrl: replacementUrl, videoAssetEtag: replacementEtag })
            .where(eq(clipPublications.id, publication.id));
        },
      }),
    ).resolves.toEqual({ claimed: 1, deleted: 0, failed: 1, stale: 0 });

    const [stored] = await db
      .select()
      .from(clipPublications)
      .where(eq(clipPublications.id, publication.id));
    expect(stored?.blobCleanupStatus).not.toBe("deleted");
    expect(stored?.videoAssetUrl).toBe(replacementUrl);
    expect(stored?.videoAssetEtag).toBe(replacementEtag);
  });

  it("cools down a failed delete instead of hot-looping in one cron run", async () => {
    const { publication } = await createCleanupCandidate("cleanup-failure-cooldown");
    let calls = 0;
    await expect(
      runVerifiedBlobCleanup({
        db,
        retentionDays: 1,
        deleteAsset: async () => {
          calls += 1;
          throw new Error("injected cleanup failure");
        },
      }),
    ).resolves.toEqual({ claimed: 1, deleted: 0, failed: 1, stale: 0 });
    expect(calls).toBe(1);

    const [stored] = await db
      .select()
      .from(clipPublications)
      .where(
        and(
          eq(clipPublications.id, publication.id),
          eq(clipPublications.blobCleanupStatus, "failed"),
        ),
      );
    expect(stored?.blobCleanupAttemptedAt).toBeInstanceOf(Date);
    await expect(claimNextBlobCleanup({ db, retentionDays: 1 })).resolves.toBeNull();
  });
});

describe("claimNextBlobCleanup eligibility boundaries", () => {
  it("excludes an asset that has not reached the retention cutoff yet, and claims one that has", async () => {
    const { publication: tooRecent } = await createCleanupCandidate("cleanup-boundary-recent", {
      publication: { publishVerifiedAt: new Date(Date.now() - 23 * 60 * 60_000) },
    });
    const { publication: eligible } = await createCleanupCandidate("cleanup-boundary-eligible", {
      publication: { publishVerifiedAt: new Date(Date.now() - 25 * 60 * 60_000) },
    });

    const claim = await claimNextBlobCleanup({ db, retentionDays: 1 });
    expect(claim?.publicationId).toBe(eligible.id);

    const second = await claimNextBlobCleanup({ db, retentionDays: 1 });
    expect(second).toBeNull();

    const [stillRetained] = await db
      .select()
      .from(clipPublications)
      .where(eq(clipPublications.id, tooRecent.id));
    expect(stillRetained?.blobCleanupStatus).toBe("retained");
  });

  it("excludes a publication where Instagram has not published yet", async () => {
    await createCleanupCandidate("cleanup-boundary-ig-unpublished", {
      publication: { instagramPublishStatus: "failed" },
    });
    await expect(claimNextBlobCleanup({ db, retentionDays: 1 })).resolves.toBeNull();
  });

  it("excludes a publication where Facebook has not published yet", async () => {
    await createCleanupCandidate("cleanup-boundary-fb-unpublished", {
      publication: { facebookPublishStatus: "failed" },
    });
    await expect(claimNextBlobCleanup({ db, retentionDays: 1 })).resolves.toBeNull();
  });

  it("excludes a publication whose clip is not in published status", async () => {
    await createCleanupCandidate("cleanup-boundary-clip-not-published", {
      clipStatus: "approved",
    });
    await expect(claimNextBlobCleanup({ db, retentionDays: 1 })).resolves.toBeNull();
  });

  it("excludes a publication with an active attempt, but claims one whose attempts are all terminal", async () => {
    const { clipId: blockedClipId, publication: blockedPublication } =
      await createCleanupCandidate("cleanup-boundary-active-attempt");
    await db.insert(publicationAttempts).values({
      clipId: blockedClipId,
      publicationId: blockedPublication.id,
      trigger: "immediate",
      status: "manual_review",
      completedAt: new Date(),
      authorizedAt: new Date(),
      authorizedCaption: "Integration authorization snapshot.",
      authorizedInstagramUserId: targets.instagramUserId,
      authorizedFacebookPageId: targets.facebookPageId,
    });

    const { clipId: freeClipId, publication: freePublication } = await createCleanupCandidate(
      "cleanup-boundary-terminal-attempt",
    );
    await db.insert(publicationAttempts).values({
      clipId: freeClipId,
      publicationId: freePublication.id,
      trigger: "immediate",
      status: "failed",
      completedAt: new Date(),
      authorizedAt: new Date(),
      authorizedCaption: "Integration authorization snapshot.",
      authorizedInstagramUserId: targets.instagramUserId,
      authorizedFacebookPageId: targets.facebookPageId,
    });

    const claim = await claimNextBlobCleanup({ db, retentionDays: 1 });
    expect(claim?.publicationId).toBe(freePublication.id);
    await expect(claimNextBlobCleanup({ db, retentionDays: 1 })).resolves.toBeNull();
  });

  it("cools down a still-recent failed cleanup instead of retrying it immediately", async () => {
    await createCleanupCandidate("cleanup-boundary-cooldown-active", {
      publication: {
        blobCleanupStatus: "failed",
        blobCleanupAttemptedAt: new Date(Date.now() - 60 * 60_000),
      },
    });
    await expect(claimNextBlobCleanup({ db, retentionDays: 1 })).resolves.toBeNull();
  });

  it("claims a failed cleanup again once its cooldown has elapsed", async () => {
    const { publication } = await createCleanupCandidate("cleanup-boundary-cooldown-elapsed", {
      publication: {
        blobCleanupStatus: "failed",
        blobCleanupAttemptedAt: new Date(Date.now() - 13 * 60 * 60_000),
      },
    });
    const claim = await claimNextBlobCleanup({ db, retentionDays: 1 });
    expect(claim?.publicationId).toBe(publication.id);
  });
});
