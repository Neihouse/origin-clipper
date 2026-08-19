import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { clips } from "@/db/schema";
import { requireSession } from "@/lib/auth/require-session";
import { config } from "@/lib/config";
import { approveClip, rejectClip } from "../actions";
import { PublishButton } from "../PublishButton";
import { formatDuration, formatScore, platformStatusLabel, platformStatusClass } from "../format";
import { NotesForm } from "./NotesForm";

export const dynamic = "force-dynamic";

function formatDateTime(value: Date | string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ClipDetailPage({ params }: PageProps) {
  await requireSession();
  const { id } = await params;

  const db = getDb();
  const [clip] = await db.select().from(clips).where(eq(clips.id, id)).limit(1);
  if (!clip) notFound();

  const canApprove = clip.status !== "approved" && clip.status !== "published";
  const canReject = clip.status !== "rejected" && clip.status !== "published";

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
          <p className="cta-line">
            Book a DJ recording — $250 ·{" "}
            <a href={config.den.bookingUrl} target="_blank" rel="noreferrer">
              {config.den.bookingUrl}
            </a>
          </p>
        </section>
      ) : null}

      <section className="detail-section">
        <h2>Notes</h2>
        <NotesForm clipId={clip.id} initialNotes={clip.notes} />
      </section>

      <section className="detail-section">
        <h2>Publishing</h2>
        <dl className="detail-grid">
          <dt>Instagram</dt>
          <dd className={platformStatusClass(clip.instagramPublishStatus)}>
            {platformStatusLabel(clip.instagramPublishStatus)}
            {clip.instagramPermalink ? (
              <>
                {" "}
                ·{" "}
                <a href={clip.instagramPermalink} target="_blank" rel="noreferrer">
                  view live
                </a>
              </>
            ) : null}
            {clip.instagramPublishError ? (
              <span className="publish-error-detail"> — {clip.instagramPublishError}</span>
            ) : null}
          </dd>

          <dt>Facebook</dt>
          <dd className={platformStatusClass(clip.facebookPublishStatus)}>
            {platformStatusLabel(clip.facebookPublishStatus)}
            {clip.facebookPermalink ? (
              <>
                {" "}
                ·{" "}
                <a href={clip.facebookPermalink} target="_blank" rel="noreferrer">
                  view live
                </a>
              </>
            ) : null}
            {clip.facebookPublishError ? (
              <span className="publish-error-detail"> — {clip.facebookPublishError}</span>
            ) : null}
          </dd>

          <dt>Video asset</dt>
          <dd>
            {clip.videoAssetUrl ? (
              <a href={clip.videoAssetUrl} target="_blank" rel="noreferrer">
                rehosted copy
              </a>
            ) : (
              "Not yet rehosted"
            )}
            {clip.videoAssetError ? (
              <span className="publish-error-detail"> — {clip.videoAssetError}</span>
            ) : null}
          </dd>

          <dt>Last publish attempt</dt>
          <dd>{formatDateTime(clip.publishAttemptedAt)}</dd>
        </dl>
      </section>
    </main>
  );
}
