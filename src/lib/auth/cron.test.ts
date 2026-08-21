import { describe, expect, it } from "vitest";
import { isCronAuthorized } from "./cron";

describe("isCronAuthorized", () => {
  const secret = "test-cron-secret";

  it("accepts only the exact Bearer credential", () => {
    expect(
      isCronAuthorized(
        new Request("https://example.test", {
          headers: { authorization: `Bearer ${secret}` },
        }),
        secret,
      ),
    ).toBe(true);
    expect(
      isCronAuthorized(
        new Request("https://example.test", {
          headers: { authorization: "Bearer wrong" },
        }),
        secret,
      ),
    ).toBe(false);
  });

  it("rejects missing, malformed, and prefix-only headers", () => {
    expect(isCronAuthorized(new Request("https://example.test"), secret)).toBe(false);
    expect(
      isCronAuthorized(
        new Request("https://example.test", { headers: { authorization: secret } }),
        secret,
      ),
    ).toBe(false);
    expect(
      isCronAuthorized(
        new Request("https://example.test", { headers: { authorization: "Bearer" } }),
        secret,
      ),
    ).toBe(false);
  });
});
