import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/auth/cron";
import { runDueScheduledPublishes } from "@/lib/publishing/scheduled";

export const maxDuration = 300;

export async function GET(request: Request) {
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const summary = await runDueScheduledPublishes();
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    // Never return raw database/platform errors or request data from this
    // public route. The name is sufficient for infrastructure diagnostics.
    console.error("Scheduled publishing worker failed:", {
      name: error instanceof Error ? error.name : typeof error,
    });
    return NextResponse.json({ ok: false, error: "Scheduled publishing failed" }, { status: 500 });
  }
}
