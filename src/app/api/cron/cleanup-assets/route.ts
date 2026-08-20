import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/auth/cron";
import { runVerifiedBlobCleanup } from "@/lib/publishing/blob-cleanup";

export const maxDuration = 300;

export async function GET(request: Request) {
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const summary = await runVerifiedBlobCleanup();
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    console.error("Verified Blob cleanup failed:", {
      name: error instanceof Error ? error.name : typeof error,
    });
    return NextResponse.json({ ok: false, error: "Asset cleanup failed" }, { status: 500 });
  }
}
