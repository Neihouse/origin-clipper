import { describe, expect, it } from "vitest";
import {
  isDueAuthorizedSchedule,
  resolveAuthorizedPublishContext,
  resolveScheduleOutcome,
  validateScheduleTime,
} from "./policy";

describe("validateScheduleTime", () => {
  it("accepts an exact timezone-bearing Pacific instant", () => {
    const result = validateScheduleTime({
      scheduledFor: "2026-08-20T20:00:00.000Z",
      scheduledForLocal: "2026-08-20T13:00",
      timeZone: "America/Los_Angeles",
      now: new Date("2026-08-20T19:00:00.000Z"),
    });
    expect(result).toEqual({ ok: true, scheduledFor: new Date("2026-08-20T20:00:00.000Z") });
  });

  it("rejects timezone-less, past, too-soon, and beyond-28-day inputs", () => {
    const base = {
      scheduledForLocal: "2026-08-20T13:00",
      timeZone: "America/Los_Angeles",
      now: new Date("2026-08-20T19:58:00.000Z"),
    };
    expect(validateScheduleTime({ ...base, scheduledFor: "2026-08-20T20:00:00" }).ok).toBe(false);
    expect(
      validateScheduleTime({
        ...base,
        scheduledFor: "2026-08-20T19:00:00.000Z",
        scheduledForLocal: "2026-08-20T12:00",
      }).ok,
    ).toBe(false);
    expect(validateScheduleTime({ ...base, scheduledFor: "2026-08-20T20:00:00.000Z" }).ok).toBe(
      false,
    );
    expect(
      validateScheduleTime({
        scheduledFor: "2026-09-18T20:00:00.000Z",
        scheduledForLocal: "2026-09-18T13:00",
        timeZone: "America/Los_Angeles",
        now: new Date("2026-08-20T19:00:00.000Z"),
      }).ok,
    ).toBe(false);
  });

  it("rejects nonexistent and ambiguous daylight-saving wall times", () => {
    const nonexistent = validateScheduleTime({
      scheduledFor: "2026-03-08T10:30:00.000Z",
      scheduledForLocal: "2026-03-08T02:30",
      timeZone: "America/Los_Angeles",
      now: new Date("2026-03-01T12:00:00.000Z"),
    });
    expect(nonexistent).toEqual(
      expect.objectContaining({ ok: false, message: expect.stringContaining("does not exist") }),
    );

    const ambiguous = validateScheduleTime({
      scheduledFor: "2026-11-01T08:30:00.000Z",
      scheduledForLocal: "2026-11-01T01:30",
      timeZone: "America/Los_Angeles",
      now: new Date("2026-10-25T12:00:00.000Z"),
    });
    expect(ambiguous).toEqual(
      expect.objectContaining({ ok: false, message: expect.stringContaining("occurs twice") }),
    );
  });
});

describe("scheduled authorization policy", () => {
  const due = {
    status: "approved" as const,
    scheduleStatus: "scheduled" as const,
    scheduledFor: new Date("2026-08-20T20:00:00.000Z"),
    authorizedAt: new Date("2026-08-19T20:00:00.000Z"),
    authorizedCaption: "Authorized caption",
    authorizedInstagramUserId: "ig-1",
    authorizedFacebookPageId: "fb-1",
    instagramPublishStatus: "not_started" as const,
    facebookPublishStatus: "not_started" as const,
  };

  it("never treats an approved but unscheduled clip as due authorization", () => {
    expect(
      isDueAuthorizedSchedule(
        { ...due, scheduleStatus: "not_scheduled" },
        new Date("2026-08-20T20:01:00.000Z"),
      ),
    ).toBe(false);
  });

  it("requires the exact caption and destination snapshots", () => {
    const now = new Date("2026-08-20T20:01:00.000Z");
    expect(isDueAuthorizedSchedule(due, now)).toBe(true);
    expect(isDueAuthorizedSchedule({ ...due, authorizedCaption: null }, now)).toBe(false);
    expect(isDueAuthorizedSchedule({ ...due, authorizedInstagramUserId: null }, now)).toBe(false);
    expect(isDueAuthorizedSchedule({ ...due, authorizedFacebookPageId: null }, now)).toBe(false);
  });

  it("uses the authorized caption snapshot and fails closed when targets change", () => {
    const record = {
      status: "approved" as const,
      authorizedAt: new Date(),
      proposedCaption: "Later mutable text",
      authorizedCaption: "Exact authorized text",
      authorizedInstagramUserId: "ig-1",
      authorizedFacebookPageId: "fb-1",
    };
    expect(
      resolveAuthorizedPublishContext(record, {
        instagramUserId: "ig-1",
        facebookPageId: "fb-1",
      }),
    ).toEqual({
      ok: true,
      caption: "Exact authorized text",
      instagramUserId: "ig-1",
      facebookPageId: "fb-1",
    });
    expect(
      resolveAuthorizedPublishContext(record, {
        instagramUserId: "different",
        facebookPageId: "fb-1",
      }),
    ).toEqual({ ok: false, reason: "targets_changed" });
  });
});

describe("resolveScheduleOutcome", () => {
  it("completes only when both durable platform states are published", () => {
    expect(resolveScheduleOutcome("published", "published")).toBe("completed");
    expect(resolveScheduleOutcome("published", "failed")).toBe("failed");
    expect(resolveScheduleOutcome("manual_review", "published")).toBe("manual_review");
    expect(resolveScheduleOutcome("failed", "manual_review")).toBe("manual_review");
  });
});
