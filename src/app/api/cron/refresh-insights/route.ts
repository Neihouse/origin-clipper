import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/auth/cron";
import { runDueInsightsRefresh } from "@/lib/publishing/insights";

export const maxDuration = 300;

export async function GET(request: Request) {
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const summary = await runDueInsightsRefresh();
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    // Never return raw database/platform errors or request data from this
    // public route. The name is sufficient for infrastructure diagnostics.
    console.error("Insights refresh worker failed:", {
      name: error instanceof Error ? error.name : typeof error,
    });
    return NextResponse.json({ ok: false, error: "Insights refresh failed" }, { status: 500 });
  }
}
