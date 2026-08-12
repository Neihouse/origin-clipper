import { eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { clips, type NewClip } from "@/db/schema";
import { config } from "@/lib/config";
import { fetchClipsInWindow } from "@/lib/twitch/client";
import type { TwitchClip } from "@/lib/twitch/types";
import { generateProposedCopy } from "@/lib/caption";
import { explainScore, selectTopClips, type RankableClip } from "@/lib/ranking/score";

// Clips in a terminal or human-decided state are never touched by the
// weekly collector — only clips still awaiting a decision are re-ranked.
const ELIGIBLE_STATUSES = ["discovered", "shortlisted"] as const;

function toNewClipRow(clip: TwitchClip): NewClip {
  const clipCreatedAt = new Date(clip.created_at);
  return {
    twitchClipId: clip.id,
    broadcasterId: clip.broadcaster_id,
    title: clip.title,
    creatorName: clip.creator_name,
    url: clip.url,
    embedUrl: clip.embed_url,
    thumbnailUrl: clip.thumbnail_url,
    viewCount: clip.view_count,
    durationSeconds: clip.duration,
    clipCreatedAt,
    streamDate: clipCreatedAt.toISOString().slice(0, 10),
    videoId: clip.video_id || null,
    vodOffsetSeconds: clip.vod_offset ?? null,
  };
}

export interface CollectionSummary {
  windowStart: string;
  windowEnd: string;
  fetched: number;
  shortlisted: number;
}

/**
 * Fetches the last `collection.windowDays` of ORIGIN clips, upserts them
 * (idempotent on twitchClipId), then re-ranks every clip still awaiting a
 * decision and sets `shortlisted` to exactly the current top N. Approved,
 * rejected, and published clips are never touched.
 */
export async function runWeeklyCollection(): Promise<CollectionSummary> {
  const db = getDb();

  const windowEnd = new Date();
  const windowStart = new Date(
    windowEnd.getTime() - config.collection.windowDays * 24 * 60 * 60 * 1000,
  );

  const twitchClips = await fetchClipsInWindow({
    broadcasterId: config.twitch.broadcasterId,
    startedAt: windowStart,
    endedAt: windowEnd,
  });

  if (twitchClips.length > 0) {
    const rows = twitchClips.map(toNewClipRow);
    await db
      .insert(clips)
      .values(rows)
      .onConflictDoUpdate({
        target: clips.twitchClipId,
        set: {
          title: sql`excluded.title`,
          url: sql`excluded.url`,
          embedUrl: sql`excluded.embed_url`,
          thumbnailUrl: sql`excluded.thumbnail_url`,
          viewCount: sql`excluded.view_count`,
          durationSeconds: sql`excluded.duration_seconds`,
          updatedAt: sql`now()`,
        },
      });
  }

  const candidates = await db
    .select()
    .from(clips)
    .where(inArray(clips.status, ELIGIBLE_STATUSES));

  const rankable = candidates.map((c) => ({
    id: c.id,
    viewCount: c.viewCount,
    durationSeconds: c.durationSeconds,
    clipCreatedAt: c.clipCreatedAt,
    videoId: c.videoId,
    vodOffsetSeconds: c.vodOffsetSeconds,
  }));

  const top = selectTopClips<RankableClip & { id: string }>(
    rankable,
    { start: windowStart, end: windowEnd },
    config.collection.topClipLimit,
  );
  const topById = new Map(top.map((t) => [t.clip.id, t]));

  await Promise.all(
    top.map(async ({ clip: rankedClip, score }) => {
      const source = candidates.find((c) => c.id === rankedClip.id);
      if (!source) return;

      const { proposedTitle, proposedCaption } = generateProposedCopy({
        title: source.title,
        creatorName: source.creatorName,
      });

      await db
        .update(clips)
        .set({
          status: "shortlisted",
          rankingScore: score.total,
          rankingReason: explainScore(score),
          proposedTitle,
          proposedCaption,
          updatedAt: sql`now()`,
        })
        .where(eq(clips.id, rankedClip.id));
    }),
  );

  const demoteIds = candidates
    .filter((c) => c.status === "shortlisted" && !topById.has(c.id))
    .map((c) => c.id);

  if (demoteIds.length > 0) {
    await db
      .update(clips)
      .set({ status: "discovered", updatedAt: sql`now()` })
      .where(inArray(clips.id, demoteIds));
  }

  return {
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    fetched: twitchClips.length,
    shortlisted: top.length,
  };
}
