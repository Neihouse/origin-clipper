import { describe, expect, it } from "vitest";
import { buildCadenceHealth, calculateQueueOverflow } from "./cadence-health";

const now = "2026-08-20T19:00:00.000Z";

describe("cadence health", () => {
  it("reports a healthy human-curated runway", () => {
    const result = buildCadenceHealth({
      now,
      upcomingScheduledCount: 4,
      approvedUnscheduledCount: 4,
      nextDueAt: "2026-08-25T01:00:00.000Z",
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

    expect(result.dueWithinSevenDays).toBe(true);
    expect(result.attentionCount).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  it("warns about a seven-day gap without inventing a replacement slot", () => {
    const result = buildCadenceHealth({
      now,
      upcomingScheduledCount: 1,
      approvedUnscheduledCount: 4,
      nextDueAt: "2026-08-28T19:00:01.000Z",
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

    expect(result.dueWithinSevenDays).toBe(false);
    expect(result.warnings).toContainEqual({
      id: "cadence_gap",
      tone: "warning",
      message: "No post is currently due within the next 7 days.",
    });
  });

  it("warns when the approved unscheduled buffer falls below four", () => {
    const result = buildCadenceHealth({
      now,
      upcomingScheduledCount: 2,
      approvedUnscheduledCount: 3,
      nextDueAt: "2026-08-21T01:00:00.000Z",
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

    expect(result.warnings).toContainEqual({
      id: "thin_buffer",
      tone: "warning",
      message: "Approved unscheduled buffer is 3; the working target is 4.",
    });
  });

  it("combines publish and temporary-media cleanup recovery work", () => {
    const result = buildCadenceHealth({
      now,
      upcomingScheduledCount: 0,
      approvedUnscheduledCount: 0,
      nextDueAt: null,
      overdueCount: 2,
      failedCount: 1,
      manualReviewCount: 3,
      processingCount: 1,
      cleanupFailedCount: 2,
      collaborationFollowUpCount: 1,
      unverifiedCount: 1,
      postPublishFollowUpCount: 1,
      operatorAttentionCount: 7,
    });

    expect(result.attentionCount).toBe(7);
    expect(result.warnings.map((warning) => warning.id)).toEqual([
      "attention",
      "cadence_gap",
      "thin_buffer",
    ]);
  });

  it("normalizes impossible negative aggregate counts", () => {
    const result = buildCadenceHealth({
      now,
      upcomingScheduledCount: -2,
      approvedUnscheduledCount: Number.NaN,
      nextDueAt: null,
      overdueCount: -1,
      failedCount: 0,
      manualReviewCount: 0,
      processingCount: 0,
      cleanupFailedCount: 0,
      collaborationFollowUpCount: 0,
      unverifiedCount: 0,
      postPublishFollowUpCount: 0,
      operatorAttentionCount: 0,
    });

    expect(result.upcomingScheduledCount).toBe(0);
    expect(result.approvedUnscheduledCount).toBe(0);
    expect(result.attentionCount).toBe(0);
  });

  it("reports bounded-list overflow without producing a negative count", () => {
    expect(calculateQueueOverflow(73, 50)).toBe(23);
    expect(calculateQueueOverflow(3, 8)).toBe(0);
    expect(calculateQueueOverflow(Number.NaN, 1)).toBe(0);
  });
});
