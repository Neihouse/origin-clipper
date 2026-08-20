import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runDueScheduledPublishes = vi.fn();

vi.mock("@/lib/publishing/scheduled", () => ({ runDueScheduledPublishes }));

describe("scheduled publish cron route", () => {
  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", "route-test-secret");
    runDueScheduledPublishes.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("rejects unauthenticated invocations without running the worker", async () => {
    const { GET } = await import("./route");
    const response = await GET(new Request("https://example.test/api/cron/publish-scheduled"));
    expect(response.status).toBe(401);
    expect(runDueScheduledPublishes).not.toHaveBeenCalled();
  });

  it("returns a safe successful no-due summary", async () => {
    runDueScheduledPublishes.mockResolvedValue({
      claimed: 0,
      completed: 0,
      failed: 0,
      manualReview: 0,
      stale: 0,
      invalid: 0,
      alreadyComplete: 0,
    });
    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.test/api/cron/publish-scheduled", {
        headers: { authorization: "Bearer route-test-secret" },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      claimed: 0,
      completed: 0,
      failed: 0,
      manualReview: 0,
      stale: 0,
      invalid: 0,
      alreadyComplete: 0,
    });
  });

  it("returns a generic 500 without exposing an infrastructure error", async () => {
    runDueScheduledPublishes.mockRejectedValue(new Error("DATABASE_URL=secret-value"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.test/api/cron/publish-scheduled", {
        headers: { authorization: "Bearer route-test-secret" },
      }),
    );
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("secret-value");
  });
});
