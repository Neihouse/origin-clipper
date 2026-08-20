"use client";

import { useActionState, useMemo, useState } from "react";
import type { ClipStatus, PlatformPublishStatus, ScheduleStatus } from "@/db/schema";
import {
  cancelScheduledPublish,
  resolveSchedulePublishReview,
  rescheduleClip,
  scheduleClip,
  type ClipWorkflowActionState,
} from "./actions";
import { LocalTime } from "./LocalTime";
import {
  PUBLISH_TIME_ZONE,
  PUBLISH_TIME_ZONE_LABEL,
  scheduleInputBounds,
  toZonedDateTimeInputValue,
  zonedLocalDateTimeToIso,
} from "./local-time";

const initialState: ClipWorkflowActionState = { status: "idle" };

function scheduleStatusLabel(status: ScheduleStatus): string {
  switch (status) {
    case "scheduled":
      return "Scheduled";
    case "processing":
      return "Publishing in progress";
    case "completed":
      return "Scheduled publish completed";
    case "failed":
      return "Publish failed — safe to reschedule";
    case "manual_review":
      return "Manual review required";
    case "cancelled":
      return "Schedule cancelled";
    default:
      return "Not scheduled";
  }
}

function actionMessage(state: ClipWorkflowActionState) {
  if (state.status === "idle") return null;
  return (
    <p
      className={`schedule-action-message ${
        state.status === "error" ? "publish-result-error" : "publish-result-ok"
      }`}
      role={state.status === "error" ? "alert" : "status"}
    >
      {state.message}
    </p>
  );
}

interface ScheduleControlsProps {
  clipId: string;
  clipStatus: ClipStatus;
  scheduleStatus: ScheduleStatus;
  scheduledFor: string | null;
  scheduleError: string | null;
  referenceNow: string;
  instagramStatus: PlatformPublishStatus;
  facebookStatus: PlatformPublishStatus;
}

export function ScheduleControls({
  clipId,
  clipStatus,
  scheduleStatus,
  scheduledFor,
  scheduleError,
  referenceNow,
  instagramStatus,
  facebookStatus,
}: ScheduleControlsProps) {
  const [scheduleState, scheduleAction, isScheduling] = useActionState(scheduleClip, initialState);
  const [rescheduleState, rescheduleAction, isRescheduling] = useActionState(
    rescheduleClip,
    initialState,
  );
  const [cancelState, cancelAction, isCancelling] = useActionState(
    cancelScheduledPublish,
    initialState,
  );
  const [reviewState, reviewAction, isResolvingReview] = useActionState(
    resolveSchedulePublishReview,
    initialState,
  );
  const bounds = useMemo(
    () => scheduleInputBounds(new Date(referenceNow)),
    [referenceNow],
  );
  const [localValue, setLocalValue] = useState(() =>
    scheduledFor ? toZonedDateTimeInputValue(scheduledFor) : bounds.suggested,
  );
  const isOverdue = Boolean(
    scheduledFor && new Date(scheduledFor).getTime() < new Date(referenceNow).getTime(),
  );

  const conversion = useMemo(
    () => (localValue ? zonedLocalDateTimeToIso(localValue) : { error: "Choose a date and time." }),
    [localValue],
  );
  const scheduledForIso = "iso" in conversion ? conversion.iso : "";
  const conversionError = "error" in conversion ? conversion.error : null;

  const isLocked = scheduleStatus === "processing" || scheduleStatus === "manual_review";
  const canEdit =
    clipStatus === "approved" && scheduleStatus !== "completed" && !isLocked;
  const isExistingSchedule = scheduleStatus === "scheduled" || scheduleStatus === "failed";
  const formAction = isExistingSchedule ? rescheduleAction : scheduleAction;
  const isSubmitting = isExistingSchedule ? isRescheduling : isScheduling;
  const submitLabel = isExistingSchedule ? "Reschedule Publish" : "Schedule Publish";
  const platformReviewPending =
    instagramStatus === "manual_review" ||
    instagramStatus === "pending" ||
    facebookStatus === "manual_review" ||
    facebookStatus === "pending";

  return (
    <div className={`schedule-panel schedule-${scheduleStatus}`}>
      <div className="schedule-heading-row">
        <div>
          <h3>Publishing schedule</h3>
          <p className={`schedule-state schedule-state-${scheduleStatus}`}>
            {scheduleStatusLabel(scheduleStatus)}
          </p>
        </div>
        {scheduledFor ? <LocalTime value={scheduledFor} className="schedule-canonical-time" /> : null}
      </div>

      <p className="time-zone-note">All schedule controls use {PUBLISH_TIME_ZONE_LABEL}.</p>

      {isOverdue && scheduleStatus === "scheduled" ? (
        <p className="schedule-warning" role="alert">
          Overdue: the worker has not claimed this publish. Inspect the scheduler before changing
          its authorization.
        </p>
      ) : null}

      {scheduleStatus === "processing" ? (
        <p className="schedule-warning">
          The worker has claimed this clip. Publishing, cancellation, and rescheduling are locked
          until the attempt finishes.
        </p>
      ) : null}

      {scheduleStatus === "manual_review" ? (
        <>
          <p className="schedule-manual-review" role="alert">
            A publish claim ended without a safe final state. Inspect Instagram and Facebook before
            changing this authorization.
          </p>
          {platformReviewPending ? (
            <p className="time-zone-note">
              Resolve every platform marked Manual review in the checklist below first.
            </p>
          ) : (
            <form action={reviewAction} className="schedule-review-form">
              <input type="hidden" name="id" value={clipId} />
              <label htmlFor={`schedule-review-${clipId}`}>After inspecting both accounts</label>
              <select
                id={`schedule-review-${clipId}`}
                name="resolution"
                defaultValue="retryable_failed"
              >
                <option value="retryable_failed">No post can still complete — unlock a retry</option>
                <option value="cancelled">Cancel this scheduled authorization</option>
              </select>
              <button type="submit" className="workflow-button" disabled={isResolvingReview}>
                {isResolvingReview ? "Recording review…" : "Record schedule review"}
              </button>
              <p>
                This is a manual reconciliation step, not a new publish authorization. A retry still
                requires Publish now or a new Schedule Publish click.
              </p>
            </form>
          )}
        </>
      ) : null}

      {scheduleError ? (
        <p className="schedule-error" role="alert">
          {scheduleError}
        </p>
      ) : null}

      {canEdit ? (
        <form action={formAction} className="schedule-form">
          <input type="hidden" name="id" value={clipId} />
          <input type="hidden" name="scheduledFor" value={scheduledForIso} />
          <input type="hidden" name="scheduledForLocal" value={localValue} />
          <input type="hidden" name="timeZone" value={PUBLISH_TIME_ZONE} />
          <label htmlFor={`scheduled-for-${clipId}`}>Publish date and time</label>
          <div className="schedule-input-row">
            <input
              id={`scheduled-for-${clipId}`}
              type="datetime-local"
              value={localValue}
              min={bounds.min}
              max={bounds.max}
              onChange={(event) => setLocalValue(event.target.value)}
              required
            />
            <button
              type="submit"
              className="schedule-button"
              disabled={isSubmitting || Boolean(conversionError)}
            >
              {isSubmitting ? "Saving schedule…" : submitLabel}
            </button>
          </div>
          {conversionError && localValue ? (
            <p className="schedule-field-error" role="alert">
              {conversionError}
            </p>
          ) : null}
          <p className="schedule-authorization-note">
            Clicking {submitLabel} authorizes this approved clip once. It becomes eligible at the
            selected time and publishes on the next 15-minute worker run; no other clip is
            authorized.
          </p>
        </form>
      ) : null}

      {scheduleStatus === "scheduled" ? (
        <form action={cancelAction} className="schedule-cancel-form">
          <input type="hidden" name="id" value={clipId} />
          <button type="submit" className="schedule-cancel-button" disabled={isCancelling}>
            {isCancelling ? "Cancelling…" : "Cancel scheduled publish"}
          </button>
          <span>Cancel first if you want to publish immediately.</span>
        </form>
      ) : null}

      {actionMessage(isExistingSchedule ? rescheduleState : scheduleState)}
      {actionMessage(cancelState)}
      {actionMessage(reviewState)}
    </div>
  );
}
