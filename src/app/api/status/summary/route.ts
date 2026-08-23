import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { clips } from "@/db/schema";
import { isStatusAuthorized } from "@/lib/auth/status-key";
import { getCadencePublishingDashboard } from "@/lib/publishing/queries";
import { buildCadenceHealth, ADMIN_CADENCE_QUEUE_LIMIT } from "@/app/admin/clips/cadence-health";

export const dynamic = "force-dynamic";

/**
 * Read-only JSON snapshot for external aggregation (e.g. a cross-tool
 * dashboard). Deliberately narrower than the /admin/clips page: counts and
 * cadence health only, no clip titles/creator names/notes.
 */
export async function GET(request: Request) {
  if (!isStatusAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = getDb();
  const now = new Date();
  const horizon = new Date(now.getTime() + 28 * 24 * 60 * 60 * 1000);

  const [statusCounts, cadence] = await Promise.all([
    db
      .select({ status: clips.status, count: sql<number>`count(*)::int` })
      .from(clips)
      .groupBy(clips.status),
    getCadencePublishingDashboard({ now, horizon, limit: ADMIN_CADENCE_QUEUE_LIMIT }, db),
  ]);

  const health = buildCadenceHealth({ now, ...cadence.metrics });

  return NextResponse.json({
    checkedAt: now.toISOString(),
    clipCounts: Object.fromEntries(statusCounts.map((row) => [row.status, row.count])),
    cadence: {
      warnings: health.warnings,
      dueWithinSevenDays: health.dueWithinSevenDays,
      nextDueAt: health.nextDueAt,
      upcomingScheduledCount: health.upcomingScheduledCount,
      approvedUnscheduledCount: health.approvedUnscheduledCount,
      overdueCount: health.overdueCount,
      failedCount: health.failedCount,
      manualReviewCount: health.manualReviewCount,
      attentionCount: health.attentionCount,
    },
  });
}
