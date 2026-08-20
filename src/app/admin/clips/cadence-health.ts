export const CADENCE_WINDOW_DAYS = 28;
export const CADENCE_GAP_DAYS = 7;
export const APPROVED_BUFFER_TARGET = 4;
export const ADMIN_CADENCE_QUEUE_LIMIT = 50;

export function calculateQueueOverflow(totalCount: number, shownCount: number): number {
  return Math.max(0, nonNegativeInteger(totalCount) - nonNegativeInteger(shownCount));
}

export interface CadenceHealthInput {
  now: Date | string;
  upcomingScheduledCount: number;
  approvedUnscheduledCount: number;
  nextDueAt: Date | string | null;
  overdueCount: number;
  failedCount: number;
  manualReviewCount: number;
  processingCount: number;
  cleanupFailedCount: number;
  collaborationFollowUpCount: number;
  unverifiedCount: number;
  postPublishFollowUpCount: number;
  operatorAttentionCount: number;
}

export interface CadenceHealthWarning {
  id: "attention" | "cadence_gap" | "thin_buffer";
  tone: "warning" | "danger";
  message: string;
}

export interface CadenceHealthSnapshot extends CadenceHealthInput {
  now: string;
  nextDueAt: string | null;
  dueWithinSevenDays: boolean;
  attentionCount: number;
  warnings: CadenceHealthWarning[];
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

export function buildCadenceHealth(input: CadenceHealthInput): CadenceHealthSnapshot {
  const now = new Date(input.now);
  if (!Number.isFinite(now.getTime())) throw new Error("Cadence health requires a valid now value.");

  const nextDue = input.nextDueAt ? new Date(input.nextDueAt) : null;
  if (nextDue && !Number.isFinite(nextDue.getTime())) {
    throw new Error("Cadence health requires a valid next due time.");
  }

  const upcomingScheduledCount = nonNegativeInteger(input.upcomingScheduledCount);
  const approvedUnscheduledCount = nonNegativeInteger(input.approvedUnscheduledCount);
  const overdueCount = nonNegativeInteger(input.overdueCount);
  const failedCount = nonNegativeInteger(input.failedCount);
  const manualReviewCount = nonNegativeInteger(input.manualReviewCount);
  const processingCount = nonNegativeInteger(input.processingCount);
  const cleanupFailedCount = nonNegativeInteger(input.cleanupFailedCount);
  const collaborationFollowUpCount = nonNegativeInteger(input.collaborationFollowUpCount);
  const unverifiedCount = nonNegativeInteger(input.unverifiedCount);
  const postPublishFollowUpCount = nonNegativeInteger(input.postPublishFollowUpCount);
  const attentionCount = nonNegativeInteger(input.operatorAttentionCount);
  const sevenDaysFromNow = now.getTime() + CADENCE_GAP_DAYS * 24 * 60 * 60 * 1000;
  const dueWithinSevenDays = Boolean(
    nextDue && nextDue.getTime() >= now.getTime() && nextDue.getTime() <= sevenDaysFromNow,
  );

  const warnings: CadenceHealthWarning[] = [];
  if (attentionCount > 0) {
    warnings.push({
      id: "attention",
      tone: "danger",
      message: `${attentionCount} publication ${attentionCount === 1 ? "item needs" : "items need"} operator attention.`,
    });
  }
  if (!dueWithinSevenDays) {
    warnings.push({
      id: "cadence_gap",
      tone: "warning",
      message: "No post is currently due within the next 7 days.",
    });
  }
  if (approvedUnscheduledCount < APPROVED_BUFFER_TARGET) {
    warnings.push({
      id: "thin_buffer",
      tone: "warning",
      message: `Approved unscheduled buffer is ${approvedUnscheduledCount}; the working target is ${APPROVED_BUFFER_TARGET}.`,
    });
  }

  return {
    ...input,
    now: now.toISOString(),
    nextDueAt: nextDue?.toISOString() ?? null,
    upcomingScheduledCount,
    approvedUnscheduledCount,
    overdueCount,
    failedCount,
    manualReviewCount,
    processingCount,
    cleanupFailedCount,
    collaborationFollowUpCount,
    unverifiedCount,
    postPublishFollowUpCount,
    operatorAttentionCount: attentionCount,
    dueWithinSevenDays,
    attentionCount,
    warnings,
  };
}
