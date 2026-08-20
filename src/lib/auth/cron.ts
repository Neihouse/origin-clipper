import { timingSafeEqual } from "node:crypto";
import { config } from "@/lib/config";

/** Constant-time Bearer-token check shared by every cron entrypoint. */
export function isCronAuthorized(request: Request, secret = config.cron.secret): boolean {
  const header = request.headers.get("authorization");
  if (!header) return false;

  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(header);
  if (actual.length !== expected.length) return false;

  return timingSafeEqual(actual, expected);
}
