import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runDueInsightsRefresh = vi.fn();

vi.mock("@/lib/publishing/insights", () => ({ runDueInsightsRefresh }));

describe("refresh insights cron route", () => {
  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", "route-test-secret");
    runDueInsightsRefresh.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("rejects unauthenticated invocations without running the worker", async () => {
    const { GET } = await import("./route");
    const response = await GET(new Request("https://example.test/api/cron/refresh-insights"));
    expect(response.status).toBe(401);
    expect(runDueInsightsRefresh).not.toHaveBeenCalled();
  });

  it("returns a safe successful no-due summary", async () => {
    runDueInsightsRefresh.mockResolvedValue({ attempted: 0, refreshed: 0, errored: 0 });
    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.test/api/cron/refresh-insights", {
        headers: { authorization: "Bearer route-test-secret" },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, attempted: 0, refreshed: 0, errored: 0 });
  });

  it("returns a generic 500 without exposing an infrastructure error", async () => {
    runDueInsightsRefresh.mockRejectedValue(new Error("DATABASE_URL=secret-value"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.test/api/cron/refresh-insights", {
        headers: { authorization: "Bearer route-test-secret" },
      }),
    );
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("secret-value");
  });
});
