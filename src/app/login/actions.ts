"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { config } from "@/lib/config";
import { verifyPassword } from "@/lib/auth/password";
import { checkLoginRateLimit } from "@/lib/auth/rate-limit";
import {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  createSessionToken,
} from "@/lib/auth/session";

export interface LoginState {
  error?: string;
}

async function getClientKey(): Promise<string> {
  const headerStore = await headers();
  const forwardedFor = headerStore.get("x-forwarded-for");
  return forwardedFor?.split(",")[0]?.trim() || "unknown";
}

export async function loginAction(
  _prevState: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const clientKey = await getClientKey();
  if (!checkLoginRateLimit(clientKey)) {
    return { error: "Too many attempts. Try again in a few minutes." };
  }

  const password = formData.get("password");
  if (typeof password !== "string" || password.length === 0) {
    return { error: "Enter the admin password." };
  }

  if (!verifyPassword(password, config.admin.passwordHash)) {
    return { error: "Incorrect password." };
  }

  const token = await createSessionToken();
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });

  redirect("/admin/clips");
}
