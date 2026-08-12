import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME, verifySessionToken } from "./session";

/**
 * Defense-in-depth check for server actions / route handlers under /admin.
 * The route itself is already gated by middleware, but mutations re-check
 * so they stay safe even if invoked in a way that bypasses the matcher.
 */
export async function requireSession(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const isValid = token ? await verifySessionToken(token) : false;
  if (!isValid) {
    throw new Error("Unauthorized");
  }
}
