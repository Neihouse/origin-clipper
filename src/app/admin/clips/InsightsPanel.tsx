"use client";

import { useActionState } from "react";
import type { PlatformPublishStatus } from "@/db/schema";
import type { ClipInsightsState } from "@/lib/publishing/queries";
import { ActionFeedback } from "./ActionFeedback";
import { refreshClipInsights, type ClipWorkflowActionState } from "./actions";
import { LocalTime } from "./LocalTime";

const initialState: ClipWorkflowActionState = { status: "idle" };

function formatMetric(value: number | null): string {
  return value === null ? "—" : value.toLocaleString();
}

interface Metric {
  label: string;
  value: number | null;
}

function PlatformInsights({
  label,
  published,
  fetchedAt,
  error,
  metrics,
}: {
  label: string;
  published: boolean;
  fetchedAt: Date | null;
  error: string | null;
  metrics: Metric[];
}) {
  return (
    <div className="insights-platform">
      <h4>{label}</h4>
      {!published ? (
        <p className="publish-error-detail">Not published yet.</p>
      ) : !fetchedAt ? (
        <>
          <p className="publish-result-pending">Not fetched yet.</p>
          {error ? <p className="publish-result-error">{error}</p> : null}
        </>
      ) : (
        <>
          <dl className="insights-metric-grid">
            {metrics.map((metric) => (
              <div className="insights-metric" key={metric.label}>
                <dt>{metric.label}</dt>
                <dd>{formatMetric(metric.value)}</dd>
              </div>
            ))}
          </dl>
          <p className="publish-error-detail">
            as of <LocalTime value={fetchedAt.toISOString()} />
          </p>
          {error ? <p className="publish-result-error">{error}</p> : null}
        </>
      )}
    </div>
  );
}

interface InsightsPanelProps {
  clipId: string;
  instagramStatus: PlatformPublishStatus;
  facebookStatus: PlatformPublishStatus;
  insights: ClipInsightsState;
}

export function InsightsPanel({
  clipId,
  instagramStatus,
  facebookStatus,
  insights,
}: InsightsPanelProps) {
  const [state, action, isPending] = useActionState(refreshClipInsights, initialState);
  const canRefresh = instagramStatus === "published" || facebookStatus === "published";

  return (
    <div className="insights-panel">
      <div className="insights-panel-platforms">
        <PlatformInsights
          label="Instagram"
          published={instagramStatus === "published"}
          fetchedAt={insights.instagramInsightsFetchedAt}
          error={insights.instagramInsightsError}
          metrics={[
            { label: "Plays", value: insights.instagramViews },
            { label: "Reach", value: insights.instagramReach },
            { label: "Likes", value: insights.instagramLikes },
            { label: "Comments", value: insights.instagramComments },
            { label: "Shares", value: insights.instagramShares },
            { label: "Saved", value: insights.instagramSaved },
          ]}
        />
        <PlatformInsights
          label="Facebook"
          published={facebookStatus === "published"}
          fetchedAt={insights.facebookInsightsFetchedAt}
          error={insights.facebookInsightsError}
          metrics={[
            { label: "Views", value: insights.facebookVideoViews },
            { label: "Reactions", value: insights.facebookReactions },
            { label: "Comments", value: insights.facebookComments },
            { label: "Shares", value: insights.facebookShares },
          ]}
        />
      </div>

      {canRefresh ? (
        <form action={action}>
          <input type="hidden" name="id" value={clipId} />
          <button type="submit" className="workflow-button" disabled={isPending}>
            {isPending ? "Refreshing…" : "Refresh insights"}
          </button>
          <ActionFeedback state={state} />
        </form>
      ) : null}
    </div>
  );
}
