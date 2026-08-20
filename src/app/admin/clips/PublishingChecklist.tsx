"use client";

import { useActionState, useState } from "react";
import type {
  BlobCleanupStatus,
  InstagramCollaborationStatus,
  PlatformPublishStatus,
  ScheduleStatus,
} from "@/db/schema";
import {
  resolvePlatformPublishReview,
  updateInstagramCollaboration,
  verifyPublishedClip,
  type ClipWorkflowActionState,
} from "./actions";
import { LocalTime } from "./LocalTime";

const initialState: ClipWorkflowActionState = { status: "idle" };

function ActionFeedback({ state }: { state: ClipWorkflowActionState }) {
  if (state.status === "idle") return null;
  return (
    <p
      className={state.status === "error" ? "publish-result-error" : "publish-result-ok"}
      role={state.status === "error" ? "alert" : "status"}
    >
      {state.message}
    </p>
  );
}

function ManualPlatformReview({
  clipId,
  platform,
}: {
  clipId: string;
  platform: "instagram" | "facebook";
}) {
  const [state, action, isPending] = useActionState(resolvePlatformPublishReview, initialState);
  const [resolution, setResolution] = useState<"published" | "retryable_failed">("published");
  const platformLabel = platform === "instagram" ? "Instagram" : "Facebook";

  return (
    <form action={action} className="manual-review-form">
      <input type="hidden" name="id" value={clipId} />
      <input type="hidden" name="platform" value={platform} />
      <h4>{platformLabel} inspection result</h4>
      <p>
        Open the account and inspect the live profile first. Do not infer the result from the
        interrupted request.
      </p>
      <label>
        What did you confirm?
        <select
          name="resolution"
          value={resolution}
          onChange={(event) =>
            setResolution(event.target.value as "published" | "retryable_failed")
          }
        >
          <option value="published">The post is live</option>
          <option value="retryable_failed">No post exists — safe to retry</option>
        </select>
      </label>
      {resolution === "published" ? (
        <>
          <label>
            Confirmed external post/media ID
            <input
              name="externalId"
              type="text"
              inputMode="numeric"
              pattern="[0-9]+"
              required
              autoComplete="off"
            />
          </label>
          <p className="manual-review-verification-note">
            The server verifies this numeric ID with Meta and reads back its permalink before
            changing state. If Meta cannot confirm it, nothing is changed.
          </p>
        </>
      ) : null}
      <button type="submit" className="workflow-button" disabled={isPending}>
        {isPending ? "Recording result…" : "Record inspected result"}
      </button>
      <ActionFeedback state={state} />
    </form>
  );
}

interface PublishingChecklistProps {
  clipId: string;
  instagramStatus: PlatformPublishStatus;
  facebookStatus: PlatformPublishStatus;
  collaborationStatus: InstagramCollaborationStatus;
  collaborationUpdatedAt: string | null;
  publishVerifiedAt: string | null;
  scheduleStatus: ScheduleStatus;
  cleanupStatus: BlobCleanupStatus;
  cleanupError: string | null;
}

export function PublishingChecklist({
  clipId,
  instagramStatus,
  facebookStatus,
  collaborationStatus,
  collaborationUpdatedAt,
  publishVerifiedAt,
  scheduleStatus,
  cleanupStatus,
  cleanupError,
}: PublishingChecklistProps) {
  const [collaborationState, collaborationAction, isUpdatingCollaboration] = useActionState(
    updateInstagramCollaboration,
    initialState,
  );
  const [verificationState, verificationAction, isVerifying] = useActionState(
    verifyPublishedClip,
    initialState,
  );
  const bothPublished = instagramStatus === "published" && facebookStatus === "published";
  const instagramNeedsReview =
    instagramStatus === "manual_review" ||
    (scheduleStatus === "manual_review" && instagramStatus === "pending");
  const facebookNeedsReview =
    facebookStatus === "manual_review" ||
    (scheduleStatus === "manual_review" && facebookStatus === "pending");
  const hasManualReview = instagramNeedsReview || facebookNeedsReview;
  const hasPartialPublish =
    (instagramStatus === "published") !== (facebookStatus === "published");
  const hasRetryableFailure =
    instagramStatus === "failed" || facebookStatus === "failed";

  if (
    instagramStatus === "not_started" &&
    facebookStatus === "not_started" &&
    collaborationStatus === "not_requested" &&
    !publishVerifiedAt
  ) {
    return null;
  }

  return (
    <div className="workflow-checklist">
      <div className="workflow-checklist-heading">
        <h3>Post-publish checklist</h3>
        <span>Manual operator steps</span>
      </div>

      {hasManualReview ? (
        <div className="manual-review-callout" role="alert">
          <strong>Resolve an ambiguous platform result before any retry.</strong>
          <p>
            The request may have reached Meta. Blind retrying could create a duplicate public post.
          </p>
          {instagramNeedsReview ? (
            <ManualPlatformReview clipId={clipId} platform="instagram" />
          ) : null}
          {facebookNeedsReview ? (
            <ManualPlatformReview clipId={clipId} platform="facebook" />
          ) : null}
        </div>
      ) : null}

      {hasPartialPublish && !hasManualReview ? (
        <p className="workflow-notice workflow-notice-pending">
          Partial publish: the successful platform is protected from reposting. Retry only the
          platform marked Failed.
        </p>
      ) : null}

      {hasRetryableFailure && !hasManualReview ? (
        <p className="workflow-notice workflow-notice-error">
          A Failed result is recorded as safe to retry. Use Publish now, or schedule a newly
          authorized attempt.
        </p>
      ) : null}

      {instagramStatus === "published" ? (
        <div className="workflow-step">
          <div className="workflow-step-copy">
            <strong>Instagram collaboration</strong>
            {collaborationStatus === "not_requested" ? (
              <span>Invite @primordialgroove as collaborator from the Instagram app.</span>
            ) : null}
            {collaborationStatus === "pending" ? (
              <span>
                Invitation marked pending. Confirm acceptance from @primordialgroove before marking
                complete.
              </span>
            ) : null}
            {collaborationStatus === "accepted" ? (
              <span>
                Collaboration marked accepted
                {collaborationUpdatedAt ? (
                  <>
                    {" "}· <LocalTime value={collaborationUpdatedAt} />
                  </>
                ) : null}
              </span>
            ) : null}
          </div>

          {collaborationStatus !== "accepted" ? (
            <form action={collaborationAction}>
              <input type="hidden" name="id" value={clipId} />
              <input
                type="hidden"
                name="collaborationStatus"
                value={collaborationStatus === "not_requested" ? "pending" : "accepted"}
              />
              <button type="submit" className="workflow-button" disabled={isUpdatingCollaboration}>
                {isUpdatingCollaboration
                  ? "Saving…"
                  : collaborationStatus === "not_requested"
                    ? "Mark invitation sent"
                    : "Mark collaboration accepted"}
              </button>
            </form>
          ) : (
            <span className="workflow-check">✓</span>
          )}
          <ActionFeedback state={collaborationState} />
        </div>
      ) : (
        <div className="workflow-step workflow-step-disabled">
          <div className="workflow-step-copy">
            <strong>Instagram collaboration</strong>
            <span>Available after Instagram reports Published.</span>
          </div>
        </div>
      )}

      <div className={`workflow-step ${bothPublished ? "" : "workflow-step-disabled"}`}>
        <div className="workflow-step-copy">
          <strong>Verify both public posts</strong>
          {publishVerifiedAt ? (
            <span>
              Manually verified · <LocalTime value={publishVerifiedAt} />
            </span>
          ) : bothPublished ? (
            <span>Open both live posts and check the video, caption, and attribution.</span>
          ) : (
            <span>Unlocks only after Instagram and Facebook both report Published.</span>
          )}
        </div>
        {bothPublished && !publishVerifiedAt ? (
          <form action={verificationAction}>
            <input type="hidden" name="id" value={clipId} />
            <button type="submit" className="workflow-button" disabled={isVerifying}>
              {isVerifying ? "Marking verified…" : "Mark publishing verified"}
            </button>
          </form>
        ) : publishVerifiedAt ? (
          <span className="workflow-check">✓</span>
        ) : null}
        <ActionFeedback state={verificationState} />
      </div>

      {publishVerifiedAt || cleanupStatus !== "retained" ? (
        <div className={`workflow-step ${cleanupStatus === "failed" ? "workflow-step-error" : ""}`}>
          <div className="workflow-step-copy">
            <strong>Temporary media cleanup</strong>
            <span>
              {cleanupStatus === "deleted"
                ? "Temporary Blob deleted after the retention window."
                : cleanupStatus === "processing"
                  ? "Cleanup worker is deleting the verified temporary asset."
                  : cleanupStatus === "failed"
                    ? "Cleanup failed and will retry after its cooldown."
                    : "Verified asset is retained until its cleanup window opens."}
              {cleanupError ? ` ${cleanupError}` : ""}
            </span>
          </div>
          {cleanupStatus === "deleted" ? <span className="workflow-check">✓</span> : null}
        </div>
      ) : null}
    </div>
  );
}
