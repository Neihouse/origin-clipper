import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runVerifiedBlobCleanup = vi.fn();

vi.mock("@/lib/publishing/blob-cleanup", () => ({ runVerifiedBlobCleanup }));

describe("verified Blob cleanup cron route", () => {
  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", "route-test-secret");
    runVerifiedBlobCleanup.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("rejects unauthenticated invocations without deleting assets", async () => {
    const { GET } = await import("./route");
    const response = await GET(new Request("https://example.test/api/cron/cleanup-assets"));
    expect(response.status).toBe(401);
    expect(runVerifiedBlobCleanup).not.toHaveBeenCalled();
  });

  it("returns a safe cleanup summary", async () => {
    runVerifiedBlobCleanup.mockResolvedValue({ claimed: 1, deleted: 1, failed: 0, stale: 0 });
    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.test/api/cron/cleanup-assets", {
        headers: { authorization: "Bearer route-test-secret" },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      claimed: 1,
      deleted: 1,
      failed: 0,
      stale: 0,
    });
  });

  it("does not expose infrastructure errors", async () => {
    runVerifiedBlobCleanup.mockRejectedValue(new Error("BLOB_READ_WRITE_TOKEN=secret-value"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.test/api/cron/cleanup-assets", {
        headers: { authorization: "Bearer route-test-secret" },
      }),
    );
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("secret-value");
  });
});
