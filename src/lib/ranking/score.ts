/**
 * Deterministic, transparent clip ranking.
 *
 * This is NOT a claim that the algorithm can judge artistic or creative
 * quality — it only combines factual signals Twitch actually reports:
 * view count, recency within the collection window, and duration fit for
 * short-form vertical platforms (Reels / TikTok / Shorts). A human still
 * makes the final call in the review queue.
 *
 * Score = 0.5 * viewScore + 0.25 * recencyScore + 0.25 * durationScore,
 * each component normalized to [0, 1]. Duplicate-moment avoidance is
 * applied separately in `selectTopClips`, since it's a selection-order
 * concern rather than a per-clip score.
 */

export interface RankableClip {
  viewCount: number;
  durationSeconds: number;
  clipCreatedAt: Date;
  videoId?: string | null;
  vodOffsetSeconds?: number | null;
}

export interface RankingWindow {
  start: Date;
  end: Date;
}

export interface ScoreBreakdown {
  viewScore: number;
  recencyScore: number;
  durationScore: number;
  total: number;
}

export const RANKING_WEIGHTS = {
  views: 0.5,
  recency: 0.25,
  duration: 0.25,
} as const;

// View count at which the view score saturates to 1.0. Log scale so one
// viral outlier doesn't make every other clip's score irrelevant.
const VIEW_SATURATION = 5000;

// Sweet spot for short-form vertical repost (seconds).
const IDEAL_DURATION_RANGE = { min: 20, max: 45 };
// Outside this range the duration score is 0.
const ACCEPTABLE_DURATION_RANGE = { min: 8, max: 60 };

// Clips from the same source VOD within this many seconds of each other are
// treated as covering the same moment for duplicate avoidance.
export const DUPLICATE_MOMENT_WINDOW_SECONDS = 90;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function computeViewScore(viewCount: number): number {
  const clamped = Math.max(0, viewCount);
  return clamp(Math.log10(clamped + 1) / Math.log10(VIEW_SATURATION + 1), 0, 1);
}

function computeRecencyScore(clipCreatedAt: Date, window: RankingWindow): number {
  const windowMs = window.end.getTime() - window.start.getTime();
  if (windowMs <= 0) return 1;
  const ageMs = window.end.getTime() - clipCreatedAt.getTime();
  return clamp(1 - ageMs / windowMs, 0, 1);
}

function computeDurationScore(durationSeconds: number): number {
  const { min: idealMin, max: idealMax } = IDEAL_DURATION_RANGE;
  const { min: floorMin, max: ceilMax } = ACCEPTABLE_DURATION_RANGE;

  if (durationSeconds >= idealMin && durationSeconds <= idealMax) return 1;

  if (durationSeconds < idealMin) {
    if (durationSeconds <= floorMin) return 0;
    return (durationSeconds - floorMin) / (idealMin - floorMin);
  }

  if (durationSeconds >= ceilMax) return 0;
  return (ceilMax - durationSeconds) / (ceilMax - idealMax);
}

export function scoreClip(clip: RankableClip, window: RankingWindow): ScoreBreakdown {
  const viewScore = computeViewScore(clip.viewCount);
  const recencyScore = computeRecencyScore(clip.clipCreatedAt, window);
  const durationScore = computeDurationScore(clip.durationSeconds);

  const total =
    viewScore * RANKING_WEIGHTS.views +
    recencyScore * RANKING_WEIGHTS.recency +
    durationScore * RANKING_WEIGHTS.duration;

  return { viewScore, recencyScore, durationScore, total };
}

/** Short human-readable explanation for the review queue, e.g. "Score 72/100 — views 60%, recency 90%, duration fit 60%". */
export function explainScore(score: ScoreBreakdown): string {
  const summary = [
    `views ${Math.round(score.viewScore * 100)}%`,
    `recency ${Math.round(score.recencyScore * 100)}%`,
    `duration fit ${Math.round(score.durationScore * 100)}%`,
  ].join(", ");
  return `Score ${Math.round(score.total * 100)}/100 — ${summary}`;
}

export interface ScoredClip<T extends RankableClip> {
  clip: T;
  score: ScoreBreakdown;
}

/**
 * Scores every clip, sorts descending, and greedily selects up to `limit`
 * clips while skipping any clip that covers the same VOD moment as one
 * already selected (duplicate avoidance).
 */
export function selectTopClips<T extends RankableClip>(
  clips: T[],
  window: RankingWindow,
  limit: number,
): ScoredClip<T>[] {
  const scored = clips
    .map((clip) => ({ clip, score: scoreClip(clip, window) }))
    .sort((a, b) => b.score.total - a.score.total);

  const selected: ScoredClip<T>[] = [];
  const takenMoments: { videoId: string; offset: number }[] = [];

  for (const candidate of scored) {
    if (selected.length >= limit) break;

    const { videoId, vodOffsetSeconds } = candidate.clip;
    const isDuplicateMoment =
      videoId != null &&
      vodOffsetSeconds != null &&
      takenMoments.some(
        (taken) =>
          taken.videoId === videoId &&
          Math.abs(taken.offset - vodOffsetSeconds) <= DUPLICATE_MOMENT_WINDOW_SECONDS,
      );

    if (isDuplicateMoment) continue;

    selected.push(candidate);
    if (videoId != null && vodOffsetSeconds != null) {
      takenMoments.push({ videoId, offset: vodOffsetSeconds });
    }
  }

  return selected;
}
