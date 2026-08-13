import { config } from "@/lib/config";
import type { Clip, PlatformPublishStatus } from "@/db/schema";
import { approveClip, rejectClip } from "./actions";
import { PublishButton } from "./PublishButton";

function formatDuration(seconds: number): string {
  return `${Math.round(seconds)}s`;
}

function formatScore(clip: Clip): string {
  if (clip.rankingReason) return clip.rankingReason;
  if (clip.rankingScore == null) return "Not yet scored";
  return `Score ${Math.round(clip.rankingScore * 100)}/100`;
}

function platformStatusLabel(status: PlatformPublishStatus): string {
  switch (status) {
    case "published":
      return "Published";
    case "pending":
      return "Pending";
    case "failed":
      return "Failed";
    default:
      return "Not started";
  }
}

function platformStatusClass(status: PlatformPublishStatus): string {
  switch (status) {
    case "published":
      return "publish-result-ok";
    case "pending":
      return "publish-result-pending";
    case "failed":
      return "publish-result-error";
    default:
      return "";
  }
}

export function ClipCard({ clip }: { clip: Clip }) {
  const canApprove = clip.status !== "approved" && clip.status !== "published";
  const canReject = clip.status !== "rejected" && clip.status !== "published";

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

        <p className="cta-line">
          Book a DJ recording — $250 ·{" "}
          <a href={config.den.bookingUrl} target="_blank" rel="noreferrer">
            {config.den.bookingUrl}
          </a>
        </p>

        {clip.instagramPublishStatus !== "not_started" ||
        clip.facebookPublishStatus !== "not_started" ? (
          <div className="publish-status">
            <p className={`publish-result ${platformStatusClass(clip.instagramPublishStatus)}`}>
              Instagram: {platformStatusLabel(clip.instagramPublishStatus)}
              {clip.instagramPermalink ? (
                <>
                  {" "}
                  ·{" "}
                  <a href={clip.instagramPermalink} target="_blank" rel="noreferrer">
                    view live
                  </a>
                </>
              ) : null}
              {clip.instagramPublishStatus === "failed" && clip.instagramPublishError ? (
                <span className="publish-error-detail"> — {clip.instagramPublishError}</span>
              ) : null}
            </p>
            <p className={`publish-result ${platformStatusClass(clip.facebookPublishStatus)}`}>
              Facebook: {platformStatusLabel(clip.facebookPublishStatus)}
              {clip.facebookPermalink ? (
                <>
                  {" "}
                  ·{" "}
                  <a href={clip.facebookPermalink} target="_blank" rel="noreferrer">
                    view live
                  </a>
                </>
              ) : null}
              {clip.facebookPublishStatus === "failed" && clip.facebookPublishError ? (
                <span className="publish-error-detail"> — {clip.facebookPublishError}</span>
              ) : null}
            </p>
          </div>
        ) : null}

        <div className="clip-actions">
          {canApprove ? (
            <form action={approveClip}>
              <input type="hidden" name="id" value={clip.id} />
              <button type="submit" className="approve-button">
                Approve
              </button>
            </form>
          ) : null}
          {canReject ? (
            <form action={rejectClip}>
              <input type="hidden" name="id" value={clip.id} />
              <button type="submit" className="reject-button">
                Reject
              </button>
            </form>
          ) : null}
          {clip.status === "approved" ? <PublishButton clipId={clip.id} /> : null}
        </div>
      </div>
    </li>
  );
}
