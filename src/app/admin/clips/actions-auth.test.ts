import { beforeEach, describe, expect, it, vi } from "vitest";

const requireSession = vi.fn();

vi.mock("@/lib/auth/require-session", () => ({ requireSession }));

describe("schedule action authentication", () => {
  beforeEach(() => {
    requireSession.mockReset();
    requireSession.mockRejectedValue(new Error("Unauthenticated"));
  });

  it("rejects every publishing-workflow action before reading or writing form data", async () => {
    const {
      cancelScheduledPublish,
      publishClip,
      resolvePlatformPublishReview,
      resolveSchedulePublishReview,
      rescheduleClip,
      scheduleClip,
      updateInstagramCollaboration,
      verifyPublishedClip,
    } = await import("./actions");
    const empty = new FormData();
    await expect(scheduleClip({ status: "idle" }, empty)).rejects.toThrow("Unauthenticated");
    await expect(rescheduleClip({ status: "idle" }, empty)).rejects.toThrow("Unauthenticated");
    await expect(cancelScheduledPublish({ status: "idle" }, empty)).rejects.toThrow(
      "Unauthenticated",
    );
    await expect(updateInstagramCollaboration({ status: "idle" }, empty)).rejects.toThrow(
      "Unauthenticated",
    );
    await expect(verifyPublishedClip({ status: "idle" }, empty)).rejects.toThrow(
      "Unauthenticated",
    );
    await expect(resolvePlatformPublishReview({ status: "idle" }, empty)).rejects.toThrow(
      "Unauthenticated",
    );
    await expect(resolveSchedulePublishReview({ status: "idle" }, empty)).rejects.toThrow(
      "Unauthenticated",
    );
    await expect(publishClip({ status: "idle" }, empty)).rejects.toThrow("Unauthenticated");
    expect(requireSession).toHaveBeenCalledTimes(8);
  });

  it("rejects untrusted manual-review evidence before touching the database", async () => {
    requireSession.mockResolvedValue(undefined);
    const { resolvePlatformPublishReview } = await import("./actions");
    const formData = new FormData();
    formData.set("id", "clip-id");
    formData.set("platform", "instagram");
    formData.set("resolution", "published");
    formData.set("externalId", "https://attacker.example/post");
    formData.set("permalink", "https://attacker.example/post");
    await expect(resolvePlatformPublishReview({ status: "idle" }, formData)).resolves.toEqual({
      status: "error",
      message: "Enter the confirmed numeric platform post ID.",
    });
  });
});
