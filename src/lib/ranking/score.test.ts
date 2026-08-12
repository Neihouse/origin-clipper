import { describe, expect, it } from "vitest";
import {
  DUPLICATE_MOMENT_WINDOW_SECONDS,
  explainScore,
  scoreClip,
  selectTopClips,
  type RankableClip,
  type RankingWindow,
} from "./score";

const WINDOW: RankingWindow = {
  start: new Date("2026-08-01T00:00:00.000Z"),
  end: new Date("2026-08-08T00:00:00.000Z"),
};

function clip(overrides: Partial<RankableClip> = {}): RankableClip {
  return {
    viewCount: 100,
    durationSeconds: 30,
    clipCreatedAt: new Date("2026-08-05T00:00:00.000Z"),
    videoId: null,
    vodOffsetSeconds: null,
    ...overrides,
  };
}

describe("scoreClip", () => {
  it("gives zero views a zero view score", () => {
    const score = scoreClip(clip({ viewCount: 0 }), WINDOW);
    expect(score.viewScore).toBe(0);
  });

  it("saturates the view score for very high view counts", () => {
    const score = scoreClip(clip({ viewCount: 50_000 }), WINDOW);
    expect(score.viewScore).toBe(1);
  });

  it("gives more views a strictly higher view score", () => {
    const low = scoreClip(clip({ viewCount: 10 }), WINDOW);
    const high = scoreClip(clip({ viewCount: 1000 }), WINDOW);
    expect(high.viewScore).toBeGreaterThan(low.viewScore);
  });

  it("scores a clip at the end of the window near full recency", () => {
    const score = scoreClip(clip({ clipCreatedAt: WINDOW.end }), WINDOW);
    expect(score.recencyScore).toBeCloseTo(1, 5);
  });

  it("scores a clip at the start of the window near zero recency", () => {
    const score = scoreClip(clip({ clipCreatedAt: WINDOW.start }), WINDOW);
    expect(score.recencyScore).toBeCloseTo(0, 5);
  });

  it("gives ideal short-form durations a perfect duration score", () => {
    const score = scoreClip(clip({ durationSeconds: 30 }), WINDOW);
    expect(score.durationScore).toBe(1);
  });

  it("penalizes clips shorter than the acceptable floor to zero", () => {
    const score = scoreClip(clip({ durationSeconds: 3 }), WINDOW);
    expect(score.durationScore).toBe(0);
  });

  it("penalizes clips longer than the acceptable ceiling to zero", () => {
    const score = scoreClip(clip({ durationSeconds: 120 }), WINDOW);
    expect(score.durationScore).toBe(0);
  });

  it("scores durations between the floor and the ideal range partially", () => {
    const score = scoreClip(clip({ durationSeconds: 14 }), WINDOW);
    expect(score.durationScore).toBeGreaterThan(0);
    expect(score.durationScore).toBeLessThan(1);
  });

  it("combines components into a total in [0, 1]", () => {
    const score = scoreClip(clip({ viewCount: 2000, durationSeconds: 30 }), WINDOW);
    expect(score.total).toBeGreaterThan(0);
    expect(score.total).toBeLessThanOrEqual(1);
  });

  it("is deterministic for identical input", () => {
    const input = clip({ viewCount: 777, durationSeconds: 22 });
    const first = scoreClip(input, WINDOW);
    const second = scoreClip(input, WINDOW);
    expect(second).toEqual(first);
  });
});

describe("explainScore", () => {
  it("renders a readable summary with the total percentage", () => {
    const score = scoreClip(clip({ viewCount: 5000, durationSeconds: 30 }), WINDOW);
    const text = explainScore(score);
    expect(text).toContain(`${Math.round(score.total * 100)}/100`);
    expect(text).toContain("views");
    expect(text).toContain("recency");
    expect(text).toContain("duration fit");
  });
});

describe("selectTopClips", () => {
  it("returns at most `limit` clips, highest score first", () => {
    const clips = [
      clip({ viewCount: 10 }),
      clip({ viewCount: 5000 }),
      clip({ viewCount: 500 }),
      clip({ viewCount: 50 }),
    ];
    const top = selectTopClips(clips, WINDOW, 2);
    expect(top).toHaveLength(2);
    expect(top[0]?.clip.viewCount).toBe(5000);
    expect(top[1]?.clip.viewCount).toBe(500);
    expect(top[0]!.score.total).toBeGreaterThanOrEqual(top[1]!.score.total);
  });

  it("returns every clip when there are fewer than the limit", () => {
    const clips = [clip(), clip({ viewCount: 200 })];
    const top = selectTopClips(clips, WINDOW, 5);
    expect(top).toHaveLength(2);
  });

  it("skips clips that cover the same VOD moment as an already-selected clip", () => {
    const clips = [
      clip({ viewCount: 5000, videoId: "vod-1", vodOffsetSeconds: 100 }),
      // Same VOD, well within the duplicate window, lower score -> should be skipped.
      clip({
        viewCount: 1000,
        videoId: "vod-1",
        vodOffsetSeconds: 100 + DUPLICATE_MOMENT_WINDOW_SECONDS - 1,
      }),
      // Same VOD but far enough away to be a genuinely different moment.
      clip({
        viewCount: 400,
        videoId: "vod-1",
        vodOffsetSeconds: 100 + DUPLICATE_MOMENT_WINDOW_SECONDS + 1,
      }),
    ];

    const top = selectTopClips(clips, WINDOW, 3);
    expect(top).toHaveLength(2);
    expect(top.map((t) => t.clip.viewCount)).toEqual([5000, 400]);
  });

  it("does not treat clips without VOD metadata as duplicates of each other", () => {
    const clips = [
      clip({ viewCount: 300, videoId: null, vodOffsetSeconds: null }),
      clip({ viewCount: 200, videoId: null, vodOffsetSeconds: null }),
    ];
    const top = selectTopClips(clips, WINDOW, 5);
    expect(top).toHaveLength(2);
  });

  it("is deterministic across repeated calls with identical input", () => {
    const clips = [
      clip({ viewCount: 10 }),
      clip({ viewCount: 5000 }),
      clip({ viewCount: 500 }),
    ];
    const first = selectTopClips(clips, WINDOW, 2);
    const second = selectTopClips(clips, WINDOW, 2);
    expect(second.map((s) => s.clip.viewCount)).toEqual(first.map((s) => s.clip.viewCount));
  });
});
