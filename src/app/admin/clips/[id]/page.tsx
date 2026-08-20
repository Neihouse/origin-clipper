import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { clips } from "@/db/schema";
import { requireSession } from "@/lib/auth/require-session";
import { getPublishingStateForClip } from "@/lib/publishing/queries";
import { approveClip, rejectClip } from "../actions";
import { PublishingChecklist } from "../PublishingChecklist";
import { PublishButton } from "../PublishButton";
import { ScheduleControls } from "../ScheduleControls";
import { formatDuration, formatScore, platformStatusLabel, platformStatusClass } from "../format";
import { PUBLISH_TIME_ZONE } from "../local-time";
import { NotesForm } from "./NotesForm";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function formatDateTime(value: Date | string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: PUBLISH_TIME_ZONE,
    timeZoneName: "short",
  });
}

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ClipDetailPage({ params }: PageProps) {
  await requireSession();
  const { id } = await params;

  const db = getDb();
  const [[clip], publishing] = await Promise.all([
    db.select().from(clips).where(eq(clips.id, id)).limit(1),
    getPublishingStateForClip(id, db),
  ]);
  if (!clip) notFound();

  const scheduleLocksReview =
    publishing.scheduleStatus === "scheduled" ||
    publishing.scheduleStatus === "processing" ||
    publishing.scheduleStatus === "manual_review";
  const canDecide =
    (clip.status === "discovered" || clip.status === "shortlisted") &&
    (publishing.scheduleStatus === "not_scheduled" || publishing.scheduleStatus === "cancelled") &&
    !scheduleLocksReview;
  const canPublishNow = clip.status === "approved" && !scheduleLocksReview;
  const showSchedule = clip.status === "approved" || publishing.scheduleStatus !== "not_scheduled";

  return (
    <main className="detail-page">
      <Link href="/admin/clips" className="back-link">
        ← Back to queue
      </Link>

      <div className="detail-header">
        <a className="detail-media" href={clip.url} target="_blank" rel="noreferrer">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={clip.thumbnailUrl} alt={clip.title} />
        </a>

        <div className="detail-header-body">
          <div className="clip-meta">
            <span className={`status-badge status-${clip.status}`}>{clip.status}</span>
          </div>
          <h1 className="detail-title">
            <a href={clip.url} target="_blank" rel="noreferrer">
              {clip.title}
            </a>
          </h1>
          <p className="clip-stats">
            {clip.creatorName} · {clip.viewCount.toLocaleString()} views ·{" "}
            {formatDuration(clip.durationSeconds)} · captured {formatDateTime(clip.clipCreatedAt)} ·
            stream date {clip.streamDate}
          </p>

          <div className="clip-actions">
            {canDecide ? (
              <form action={approveClip}>
                <input type="hidden" name="id" value={clip.id} />
                <button type="submit" className="approve-button">
                  Approve
                </button>
              </form>
            ) : null}
            {canDecide ? (
              <form action={rejectClip}>
                <input type="hidden" name="id" value={clip.id} />
                <button type="submit" className="reject-button">
                  Reject
                </button>
              </form>
            ) : null}
            {canPublishNow ? <PublishButton clipId={clip.id} /> : null}
          </div>
        </div>
      </div>

      <section className="detail-section">
        <h2>Ranking</h2>
        <p className="detail-field">{formatScore(clip)}</p>
      </section>

      {clip.proposedTitle && clip.proposedTitle !== clip.title ? (
        <section className="detail-section">
          <h2>Proposed title</h2>
          <p className="detail-field">{clip.proposedTitle}</p>
        </section>
      ) : null}

      {clip.proposedCaption ? (
        <section className="detail-section">
          <h2>Proposed caption</h2>
          <pre className="detail-caption">{clip.proposedCaption}</pre>
        </section>
      ) : null}

      <section className="detail-section">
        <h2>Notes</h2>
        <NotesForm clipId={clip.id} initialNotes={clip.notes} />
      </section>

      {showSchedule ? (
        <section className="detail-section">
          <h2>Schedule</h2>
          <ScheduleControls
            key={`${clip.id}-${publishing.latestAttemptId ?? "none"}-${publishing.scheduleStatus}`}
            clipId={clip.id}
            clipStatus={clip.status}
            scheduleStatus={publishing.scheduleStatus}
            scheduledFor={publishing.scheduledFor?.toISOString() ?? null}
            scheduleError={publishing.scheduleError}
            referenceNow={new Date().toISOString()}
            instagramStatus={publishing.instagramPublishStatus}
            facebookStatus={publishing.facebookPublishStatus}
          />
        </section>
      ) : null}

      <section className="detail-section">
        <h2>Publishing</h2>
        <dl className="detail-grid">
          <dt>Instagram</dt>
          <dd className={platformStatusClass(publishing.instagramPublishStatus)}>
            {platformStatusLabel(publishing.instagramPublishStatus)}
            {publishing.instagramPermalink ? (
              <>
                {" "}
                ·{" "}
                <a href={publishing.instagramPermalink} target="_blank" rel="noreferrer">
                  view live
                </a>
              </>
            ) : null}
            {publishing.instagramPublishError ? (
              <span className="publish-error-detail"> — {publishing.instagramPublishError}</span>
            ) : null}
          </dd>

          <dt>Facebook</dt>
          <dd className={platformStatusClass(publishing.facebookPublishStatus)}>
            {platformStatusLabel(publishing.facebookPublishStatus)}
            {publishing.facebookPermalink ? (
              <>
                {" "}
                ·{" "}
                <a href={publishing.facebookPermalink} target="_blank" rel="noreferrer">
                  view live
                </a>
              </>
            ) : null}
            {publishing.facebookPublishError ? (
              <span className="publish-error-detail"> — {publishing.facebookPublishError}</span>
            ) : null}
          </dd>

          <dt>Video asset</dt>
          <dd>
            {publishing.videoAssetUrl ? (
              <a href={publishing.videoAssetUrl} target="_blank" rel="noreferrer">
                rehosted copy
              </a>
            ) : (
              "Not yet rehosted"
            )}
            {publishing.videoAssetError ? (
              <span className="publish-error-detail"> — {publishing.videoAssetError}</span>
            ) : null}
          </dd>

          <dt>Last publish attempt</dt>
          <dd>{formatDateTime(publishing.publishAttemptedAt)}</dd>

          <dt>Temporary media cleanup</dt>
          <dd className={publishing.blobCleanupStatus === "failed" ? "publish-result-error" : ""}>
            {publishing.blobCleanupStatus === "deleted"
              ? `Deleted ${formatDateTime(publishing.blobDeletedAt)}`
              : publishing.blobCleanupStatus === "processing"
                ? "Cleanup in progress"
                : publishing.blobCleanupStatus === "failed"
                  ? "Cleanup failed"
                  : publishing.videoAssetUrl
                    ? "Retained for a safe retry"
                    : "No temporary asset"}
            {publishing.blobCleanupError ? (
              <span className="publish-error-detail"> — {publishing.blobCleanupError}</span>
            ) : null}
          </dd>
        </dl>

        <PublishingChecklist
          clipId={clip.id}
          instagramStatus={publishing.instagramPublishStatus}
          facebookStatus={publishing.facebookPublishStatus}
          collaborationStatus={publishing.instagramCollaborationStatus}
          collaborationUpdatedAt={publishing.instagramCollaborationUpdatedAt?.toISOString() ?? null}
          publishVerifiedAt={publishing.publishVerifiedAt?.toISOString() ?? null}
          scheduleStatus={publishing.scheduleStatus}
          cleanupStatus={publishing.blobCleanupStatus}
          cleanupError={publishing.blobCleanupError}
        />
      </section>
    </main>
  );
}
