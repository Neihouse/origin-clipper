import { SignJWT, jwtVerify } from "jose";
import { config } from "@/lib/config";

export const SESSION_COOKIE_NAME = "origin_clipper_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 14; // 14 days

function getSecretKey() {
  return new TextEncoder().encode(config.admin.sessionSecret);
}

export async function createSessionToken(): Promise<string> {
  return new SignJWT({ role: "admin" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(getSecretKey());
}

export async function verifySessionToken(token: string): Promise<boolean> {
  try {
    await jwtVerify(token, getSecretKey());
    return true;
  } catch {
    return false;
  }
}
