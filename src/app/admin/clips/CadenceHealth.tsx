import { LocalTime } from "./LocalTime";
import type { CadenceHealthSnapshot } from "./cadence-health";
import { CADENCE_WINDOW_DAYS } from "./cadence-health";

export function CadenceHealth({ health }: { health: CadenceHealthSnapshot }) {
  return (
    <section className="cadence-health" aria-labelledby="cadence-health-title">
      <div className="cadence-health-header">
        <div>
          <h2 id="cadence-health-title">Cadence health</h2>
          <p>Planning signals only. An operator still chooses every clip, backup, and time.</p>
        </div>
        <span className={health.warnings.length > 0 ? "cadence-health-watch" : "cadence-health-good"}>
          {health.warnings.length > 0 ? "Review cadence" : "Cadence covered"}
        </span>
      </div>

      <dl className="cadence-metrics">
        <div>
          <dt>Next due</dt>
          <dd>{health.nextDueAt ? <LocalTime value={health.nextDueAt} /> : "None scheduled"}</dd>
        </div>
        <div>
          <dt>Next {CADENCE_WINDOW_DAYS} days</dt>
          <dd>
            {health.upcomingScheduledCount} scheduled {health.upcomingScheduledCount === 1 ? "post" : "posts"}
          </dd>
        </div>
        <div>
          <dt>Approved buffer</dt>
          <dd>{health.approvedUnscheduledCount} unscheduled</dd>
        </div>
        <div>
          <dt>Needs attention</dt>
          <dd>{health.attentionCount}</dd>
          <span>
            Overlapping flags: {health.overdueCount} overdue · {health.failedCount} failed ·{" "}
            {health.manualReviewCount} review · {health.processingCount} processing ·{" "}
            {health.cleanupFailedCount} cleanup · {health.collaborationFollowUpCount}{" "}
            collaboration · {health.unverifiedCount} unverified
          </span>
        </div>
      </dl>

      {health.warnings.length > 0 ? (
        <ul className="cadence-warnings">
          {health.warnings.map((warning) => (
            <li key={warning.id} className={`cadence-warning cadence-warning-${warning.tone}`}>
              {warning.message}
            </li>
          ))}
        </ul>
      ) : (
        <p className="cadence-covered">A post is due within 7 days and the four-clip buffer is intact.</p>
      )}
    </section>
  );
}
