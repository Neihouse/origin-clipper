import Link from "next/link";
import type { ScheduleStatus } from "@/db/schema";
import { formatZonedDateTime, PUBLISH_TIME_ZONE_LABEL } from "./local-time";

export interface UpcomingScheduleItem {
  id: string;
  title: string;
  creatorName: string;
  scheduledFor: string | null;
  publishAttemptedAt: string | null;
  scheduleStatus: ScheduleStatus;
  scheduleError: string | null;
  cleanupFailed: boolean;
  cleanupError: string | null;
  collaborationPending: boolean;
  verificationPending: boolean;
}

function compactStatusLabel(
  status: ScheduleStatus,
  overdue: boolean,
  cleanupFailed: boolean,
  collaborationPending: boolean,
  verificationPending: boolean,
): string {
  if (cleanupFailed) return "Cleanup failed";
  if (collaborationPending && verificationPending) return "Collaborate + verify";
  if (collaborationPending) return "Collaboration follow-up";
  if (verificationPending) return "Verify posts";
  if (overdue && status === "scheduled") return "Overdue";
  switch (status) {
    case "processing":
      return "Publishing";
    case "manual_review":
      return "Review required";
    case "failed":
      return "Failed";
    default:
      return status.charAt(0).toUpperCase() + status.slice(1).replaceAll("_", " ");
  }
}

function ScheduleRows({
  items,
  referenceNow,
}: {
  items: UpcomingScheduleItem[];
  referenceNow: string;
}) {
  const now = new Date(referenceNow).getTime();

  return (
    <ol className="upcoming-list">
      {items.map((item) => {
        const overdue =
          item.scheduleStatus === "scheduled" &&
          Boolean(item.scheduledFor && new Date(item.scheduledFor).getTime() < now);
        const displayTime = item.scheduledFor ?? item.publishAttemptedAt;
        const displayError = item.scheduleError ?? item.cleanupError;
        const postPublishFollowUp = item.collaborationPending || item.verificationPending;
        return (
          <li key={item.id}>
            <div className="upcoming-time">
              {!item.scheduledFor ? <span>Immediate attempt</span> : null}
              {displayTime ? (
                <time dateTime={displayTime}>{formatZonedDateTime(displayTime)}</time>
              ) : (
                <span>Time unavailable</span>
              )}
            </div>
            <div className="upcoming-item-copy">
              <Link href={`/admin/clips/${item.id}`}>{item.title}</Link>
              <span>{item.creatorName}</span>
              {displayError ? (
                <span className="publish-result-error">{displayError}</span>
              ) : null}
              {postPublishFollowUp ? (
                <span className="upcoming-follow-up">
                  {item.collaborationPending ? "Confirm @primordialgroove collaboration. " : ""}
                  {item.verificationPending ? "Inspect and verify both live posts." : ""}
                </span>
              ) : null}
            </div>
            <span
              className={`schedule-queue-status schedule-queue-${
                item.cleanupFailed
                  ? "cleanup_failed"
                  : postPublishFollowUp
                    ? "follow_up"
                    : overdue
                      ? "overdue"
                      : item.scheduleStatus
              }`}
            >
              {compactStatusLabel(
                item.scheduleStatus,
                overdue,
                item.cleanupFailed,
                item.collaborationPending,
                item.verificationPending,
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function UpcomingSchedule({
  items,
  referenceNow,
  overflowCount,
}: {
  items: UpcomingScheduleItem[];
  referenceNow: string;
  overflowCount: number;
}) {
  const now = new Date(referenceNow).getTime();
  const requiresAttention = items.filter(
    (item) =>
      item.scheduleStatus === "manual_review" ||
      item.scheduleStatus === "failed" ||
      item.scheduleStatus === "processing" ||
      item.cleanupFailed ||
      item.collaborationPending ||
      item.verificationPending ||
      (item.scheduleStatus === "scheduled" &&
        Boolean(item.scheduledFor && new Date(item.scheduledFor).getTime() < now)),
  );
  const upcoming = items.filter((item) => !requiresAttention.includes(item));

  return (
    <section className="upcoming-schedule" aria-labelledby="upcoming-schedule-title">
      <div className="upcoming-schedule-header">
        <div>
          <h2 id="upcoming-schedule-title">Cadence &amp; recovery queue</h2>
          <p>
            Upcoming four weeks in {PUBLISH_TIME_ZONE_LABEL}, plus open operator follow-up.
            Publishing still requires an explicit authorization.
          </p>
        </div>
        <span className="upcoming-count">
          {items.length} visible {items.length === 1 ? "item" : "items"}
        </span>
      </div>

      {items.length === 0 ? (
        <p className="upcoming-empty">
          No upcoming publishes or operator follow-up needs attention.
        </p>
      ) : (
        <>
          {requiresAttention.length > 0 ? (
            <div className="schedule-queue-group schedule-queue-attention">
              <h3>Needs attention or in progress</h3>
              <ScheduleRows items={requiresAttention} referenceNow={referenceNow} />
            </div>
          ) : null}
          {upcoming.length > 0 ? (
            <div className="schedule-queue-group">
              {requiresAttention.length > 0 ? <h3>Next four weeks</h3> : null}
              <ScheduleRows items={upcoming} referenceNow={referenceNow} />
            </div>
          ) : null}
        </>
      )}

      {overflowCount > 0 ? (
        <p className="schedule-queue-overflow" role="status">
          {overflowCount} additional {overflowCount === 1 ? "item is" : "items are"} outside this
          bounded view. Resolve visible attention items or use the clip filters to inspect older
          records.
        </p>
      ) : null}

      <p className="upcoming-footnote">
        Choose one primary clip and one backup during weekly review. The queue never selects or
        approves content on its own.
      </p>
    </section>
  );
}
