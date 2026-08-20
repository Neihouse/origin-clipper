import Link from "next/link";
import type { Clip } from "@/db/schema";
import type { ClipPublishingState } from "@/lib/publishing/queries";
import { approveClip, rejectClip } from "./actions";
import { PublishButton } from "./PublishButton";
import { LocalTime } from "./LocalTime";
import { formatDuration, formatScore, platformStatusLabel, platformStatusClass } from "./format";

interface AttentionFlag {
  label: string;
  tone: "attention" | "info";
}

function attentionFlag(publishing: ClipPublishingState): AttentionFlag | null {
  const bothPublished =
    publishing.instagramPublishStatus === "published" &&
    publishing.facebookPublishStatus === "published";
  const overdue =
    publishing.scheduleStatus === "scheduled" &&
    Boolean(publishing.scheduledFor && publishing.scheduledFor.getTime() < Date.now());

  if (publishing.blobCleanupStatus === "failed") return { label: "Cleanup failed", tone: "attention" };
  if (publishing.scheduleStatus === "manual_review") return { label: "Review required", tone: "attention" };
  if (publishing.scheduleStatus === "failed") return { label: "Publish failed", tone: "attention" };
  if (overdue) return { label: "Overdue", tone: "attention" };
  if (bothPublished && publishing.instagramCollaborationStatus !== "accepted") {
    return { label: "Collaboration follow-up", tone: "attention" };
  }
  if (bothPublished && !publishing.publishVerifiedAt) return { label: "Verify posts", tone: "attention" };
  if (publishing.scheduleStatus === "processing") return { label: "Publishing…", tone: "info" };
  if (publishing.scheduleStatus === "scheduled" && publishing.scheduledFor) {
    return { label: "Scheduled", tone: "info" };
  }
  return null;
}

export function ClipCard({ clip, publishing }: { clip: Clip; publishing: ClipPublishingState }) {
  const scheduleLocksReview =
    publishing.scheduleStatus === "scheduled" ||
    publishing.scheduleStatus === "processing" ||
    publishing.scheduleStatus === "manual_review";
  const canDecide =
    (clip.status === "discovered" || clip.status === "shortlisted") &&
    (publishing.scheduleStatus === "not_scheduled" || publishing.scheduleStatus === "cancelled") &&
    !scheduleLocksReview;
  const canPublishNow = clip.status === "approved" && !scheduleLocksReview;
  const flag = attentionFlag(publishing);

  return (
    <li className="clip-card">
      <a
        className="clip-media"
        href={clip.url}
        target="_blank"
        rel="noreferrer"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={clip.thumbnailUrl} alt={clip.title} loading="lazy" />
      </a>

      <div className="clip-body">
        <div className="clip-meta">
          <span className={`status-badge status-${clip.status}`}>{clip.status}</span>
          <span className="score">{formatScore(clip)}</span>
        </div>

        <h2 className="clip-title">
          <a href={clip.url} target="_blank" rel="noreferrer">
            {clip.title}
          </a>
        </h2>

        <div className="clip-card-links">
          <Link href={`/admin/clips/${clip.id}`} className="details-link">
            View details →
          </Link>
          {flag ? (
            <span className={`attention-badge attention-badge-${flag.tone}`}>
              {flag.label}
              {flag.tone === "info" && publishing.scheduledFor ? (
                <>
                  {" "}
                  · <LocalTime value={publishing.scheduledFor.toISOString()} />
                </>
              ) : null}
            </span>
          ) : null}
        </div>

        <p className="clip-stats">
          {clip.creatorName} · {clip.viewCount.toLocaleString()} views ·{" "}
          {formatDuration(clip.durationSeconds)} ·{" "}
          {new Date(clip.clipCreatedAt).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
          })}
        </p>

        {clip.proposedCaption ? (
          <details className="caption-block" open>
            <summary>Proposed caption</summary>
            <pre>{clip.proposedCaption}</pre>
          </details>
        ) : null}

        {publishing.instagramPublishStatus !== "not_started" ||
        publishing.facebookPublishStatus !== "not_started" ? (
          <div className="publish-status">
            <p className={`publish-result ${platformStatusClass(publishing.instagramPublishStatus)}`}>
              Instagram: {platformStatusLabel(publishing.instagramPublishStatus)}
              {publishing.instagramPermalink ? (
                <>
                  {" "}
                  ·{" "}
                  <a href={publishing.instagramPermalink} target="_blank" rel="noreferrer">
                    view live
                  </a>
                </>
              ) : null}
              {publishing.instagramPublishStatus === "failed" && publishing.instagramPublishError ? (
                <span className="publish-error-detail"> — {publishing.instagramPublishError}</span>
              ) : null}
            </p>
            <p className={`publish-result ${platformStatusClass(publishing.facebookPublishStatus)}`}>
              Facebook: {platformStatusLabel(publishing.facebookPublishStatus)}
              {publishing.facebookPermalink ? (
                <>
                  {" "}
                  ·{" "}
                  <a href={publishing.facebookPermalink} target="_blank" rel="noreferrer">
                    view live
                  </a>
                </>
              ) : null}
              {publishing.facebookPublishStatus === "failed" && publishing.facebookPublishError ? (
                <span className="publish-error-detail"> — {publishing.facebookPublishError}</span>
              ) : null}
            </p>
          </div>
        ) : null}

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
    </li>
  );
}
