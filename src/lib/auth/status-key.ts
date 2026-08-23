import { timingSafeEqual } from "node:crypto";
import { config } from "@/lib/config";

/** Constant-time Bearer-token check for the read-only status summary route. */
export function isStatusAuthorized(request: Request, key = config.status.apiKey): boolean {
  const header = request.headers.get("authorization");
  if (!header) return false;

  const expected = Buffer.from(`Bearer ${key}`);
  const actual = Buffer.from(header);
  if (actual.length !== expected.length) return false;

  return timingSafeEqual(actual, expected);
}
