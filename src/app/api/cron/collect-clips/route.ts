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
    console.error("Weekly clip collection failed:", error);
    return NextResponse.json({ ok: false, error: "Collection failed" }, { status: 500 });
  }
}
