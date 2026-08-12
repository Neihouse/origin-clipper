import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { runWeeklyCollection } from "@/lib/collection/run";

export const maxDuration = 60;

function isAuthorized(request: Request): boolean {
  const header = request.headers.get("authorization");
  if (!header) return false;

  const expected = Buffer.from(`Bearer ${config.cron.secret}`);
  const actual = Buffer.from(header);
  if (actual.length !== expected.length) return false;

  return timingSafeEqual(actual, expected);
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const summary = await runWeeklyCollection();
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    console.error("Weekly clip collection failed:", {
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
      code: (error as { code?: string })?.code,
      cause: cause instanceof Error ? cause.message : cause,
    });
    return NextResponse.json({ ok: false, error: "Collection failed" }, { status: 500 });
  }
}
