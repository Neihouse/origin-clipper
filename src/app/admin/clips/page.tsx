import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { clips, clipStatusEnum, type ClipStatus } from "@/db/schema";
import { requireSession } from "@/lib/auth/require-session";
import {
  getCadencePublishingDashboard,
  getPublishingStatesForClipIds,
} from "@/lib/publishing/queries";
import { CadenceHealth } from "./CadenceHealth";
import { ClipCard } from "./ClipCard";
import { CollectNowButton } from "./CollectNowButton";
import { UpcomingSchedule } from "./UpcomingSchedule";
import {
  ADMIN_CADENCE_QUEUE_LIMIT,
  buildCadenceHealth,
  CADENCE_WINDOW_DAYS,
  calculateQueueOverflow,
} from "./cadence-health";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const FILTERS: { value: ClipStatus | "all"; label: string }[] = [
  { value: "shortlisted", label: "Shortlisted" },
  { value: "discovered", label: "Discovered" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "published", label: "Published" },
  { value: "all", label: "All" },
];

function resolveStatus(raw: string | undefined): ClipStatus | "all" {
  if (raw === "all") return "all";
  if (raw && (clipStatusEnum.enumValues as string[]).includes(raw)) {
    return raw as ClipStatus;
  }
  return "shortlisted";
}

interface PageProps {
  searchParams: Promise<{ status?: string }>;
}

export default async function AdminClipsPage({ searchParams }: PageProps) {
  await requireSession();
  const { status: statusParam } = await searchParams;
  const status = resolveStatus(statusParam);

  const db = getDb();
  const scheduleWindowStarts = new Date();
  const scheduleWindowEnds = new Date(
    scheduleWindowStarts.getTime() + CADENCE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  const [rows, cadence] = await Promise.all([
    status === "all"
      ? db.select().from(clips).orderBy(desc(clips.rankingScore), desc(clips.clipCreatedAt))
      : db
          .select()
          .from(clips)
          .where(eq(clips.status, status))
          .orderBy(desc(clips.rankingScore), desc(clips.clipCreatedAt)),
    getCadencePublishingDashboard(
      {
        now: scheduleWindowStarts,
        horizon: scheduleWindowEnds,
        limit: ADMIN_CADENCE_QUEUE_LIMIT,
      },
      db,
    ),
  ]);
  const publishingStates = await getPublishingStatesForClipIds(
    rows.map((clip) => clip.id),
    db,
  );

  const upcoming = cadence.rows.map(({ clipId, title, creatorName, publishing }) => {
    const fullyPublished =
      publishing.instagramPublishStatus === "published" &&
      publishing.facebookPublishStatus === "published";
    return {
      id: clipId,
      title,
      creatorName,
      scheduledFor: publishing.scheduledFor?.toISOString() ?? null,
      publishAttemptedAt: publishing.publishAttemptedAt?.toISOString() ?? null,
      scheduleStatus: publishing.scheduleStatus,
      scheduleError: publishing.scheduleError,
      cleanupFailed: publishing.blobCleanupStatus === "failed",
      cleanupError: publishing.blobCleanupError,
      collaborationPending:
        fullyPublished && publishing.instagramCollaborationStatus !== "accepted",
      verificationPending: fullyPublished && publishing.publishVerifiedAt === null,
    };
  });
  const health = buildCadenceHealth({
    now: scheduleWindowStarts,
    ...cadence.metrics,
  });
  const overflowCount = calculateQueueOverflow(cadence.totalCount, upcoming.length);

  return (
    <main className="review-page">
      <header className="review-header">
        <div>
          <h1>ORIGIN clip review</h1>
          <p className="review-subtitle">
            Field notes from ORIGIN, documenting what emerged through Primordial Groove and
            Primordial Den. Publishing requires an approved clip plus an explicit Publish now or
            Schedule Publish action.
          </p>
        </div>
        <div className="review-header-actions">
          <CollectNowButton />
          <form action="/api/auth/logout" method="POST">
            <button type="submit" className="link-button">
              Sign out
            </button>
          </form>
        </div>
      </header>

      <CadenceHealth health={health} />
      <UpcomingSchedule
        items={upcoming}
        referenceNow={scheduleWindowStarts.toISOString()}
        overflowCount={overflowCount}
      />

      <nav className="status-filters">
        {FILTERS.map((filter) => (
          <Link
            key={filter.value}
            href={filter.value === "shortlisted" ? "/admin/clips" : `/admin/clips?status=${filter.value}`}
            className={status === filter.value ? "filter active" : "filter"}
          >
            {filter.label}
          </Link>
        ))}
      </nav>

      {rows.length === 0 ? (
        <p className="empty-state">No clips in this view yet.</p>
      ) : (
        <ul className="clip-list">
          {rows.map((clip) => (
            <ClipCard key={clip.id} clip={clip} publishing={publishingStates.get(clip.id)!} />
          ))}
        </ul>
      )}
    </main>
  );
}
