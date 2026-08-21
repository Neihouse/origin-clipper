import type {
  ClipStatus,
  PlatformPublishStatus,
  ScheduleStatus,
} from "@/db/schema";

export const PUBLISHING_TIME_ZONE = "America/Los_Angeles";
export const MIN_SCHEDULE_LEAD_MS = 5 * 60 * 1_000;
export const MAX_SCHEDULE_HORIZON_MS = 28 * 24 * 60 * 60 * 1_000;
export const PUBLISH_CLAIM_TTL_MS = 12 * 60 * 1_000;
// One weekly-cadence publish per invocation leaves ample room inside Vercel's
// five-minute route limit even when Instagram needs its full polling window.
export const SCHEDULED_PUBLISH_BATCH_SIZE = 1;

interface ValidateScheduleInput {
  scheduledFor: string;
  scheduledForLocal: string;
  timeZone: string;
  now?: Date;
}

export type ScheduleTimeValidation =
  | { ok: true; scheduledFor: Date }
  | { ok: false; message: string };

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const LOCAL_MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

function localMinuteAt(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}

/**
 * Validates the exact instant selected by the operator and round-trips its
 * original wall-clock value through America/Los_Angeles. Keeping both values
 * lets the server reject spring-forward times that browsers normalize and
 * fall-back times that would otherwise refer to two different instants.
 */
export function validateScheduleTime({
  scheduledFor,
  scheduledForLocal,
  timeZone,
  now = new Date(),
}: ValidateScheduleInput): ScheduleTimeValidation {
  if (timeZone !== PUBLISHING_TIME_ZONE) {
    return { ok: false, message: `Schedule times must use ${PUBLISHING_TIME_ZONE}.` };
  }
  if (!ISO_WITH_ZONE.test(scheduledFor) || !LOCAL_MINUTE.test(scheduledForLocal)) {
    return { ok: false, message: "Choose a valid date and time." };
  }

  const instant = new Date(scheduledFor);
  if (!Number.isFinite(instant.getTime())) {
    return { ok: false, message: "Choose a valid date and time." };
  }
  if (localMinuteAt(instant, timeZone) !== scheduledForLocal) {
    return {
      ok: false,
      message: "That local time does not exist because of daylight saving time. Choose another time.",
    };
  }

  // Los Angeles clock changes are one hour. If either adjacent real hour
  // formats to the same local minute, the choice is ambiguous.
  const oneHour = 60 * 60 * 1_000;
  if (
    localMinuteAt(new Date(instant.getTime() - oneHour), timeZone) === scheduledForLocal ||
    localMinuteAt(new Date(instant.getTime() + oneHour), timeZone) === scheduledForLocal
  ) {
    return {
      ok: false,
      message: "That local time occurs twice because of daylight saving time. Choose another time.",
    };
  }

  const leadMs = instant.getTime() - now.getTime();
  if (leadMs < MIN_SCHEDULE_LEAD_MS) {
    return { ok: false, message: "Choose a time at least 5 minutes from now." };
  }
  if (leadMs > MAX_SCHEDULE_HORIZON_MS) {
    return { ok: false, message: "Choose a time within the next 28 days." };
  }

  return { ok: true, scheduledFor: instant };
}

export function canScheduleClip(status: ClipStatus, scheduleStatus: ScheduleStatus): boolean {
  return (
    status === "approved" &&
    (scheduleStatus === "not_scheduled" ||
      scheduleStatus === "cancelled" ||
      scheduleStatus === "failed")
  );
}

export function canRescheduleClip(status: ClipStatus, scheduleStatus: ScheduleStatus): boolean {
  return status === "approved" && (scheduleStatus === "scheduled" || scheduleStatus === "failed");
}

export function canCancelScheduledPublish(scheduleStatus: ScheduleStatus): boolean {
  return scheduleStatus === "scheduled";
}

interface ClaimableSchedule {
  status: ClipStatus;
  scheduleStatus: ScheduleStatus;
  scheduledFor: Date | null;
  authorizedAt: Date | null;
  authorizedCaption: string | null;
  authorizedInstagramUserId: string | null;
  authorizedFacebookPageId: string | null;
  instagramPublishStatus: PlatformPublishStatus;
  facebookPublishStatus: PlatformPublishStatus;
}

export function isDueAuthorizedSchedule(record: ClaimableSchedule, now: Date): boolean {
  return (
    record.status === "approved" &&
    record.scheduleStatus === "scheduled" &&
    record.scheduledFor !== null &&
    record.scheduledFor.getTime() <= now.getTime() &&
    record.authorizedAt !== null &&
    Boolean(record.authorizedCaption) &&
    Boolean(record.authorizedInstagramUserId) &&
    Boolean(record.authorizedFacebookPageId) &&
    !(
      record.instagramPublishStatus === "published" &&
      record.facebookPublishStatus === "published"
    )
  );
}

export function resolveScheduleOutcome(
  instagramStatus: PlatformPublishStatus,
  facebookStatus: PlatformPublishStatus,
): "completed" | "failed" | "manual_review" {
  if (instagramStatus === "published" && facebookStatus === "published") {
    return "completed";
  }
  if (instagramStatus === "manual_review" || facebookStatus === "manual_review") {
    return "manual_review";
  }
  return "failed";
}

interface AuthorizedPublishRecord {
  status: ClipStatus;
  authorizedAt: Date | null;
  proposedCaption: string | null;
  authorizedCaption: string | null;
  authorizedInstagramUserId: string | null;
  authorizedFacebookPageId: string | null;
}

interface CurrentPublishTargets {
  instagramUserId: string;
  facebookPageId: string;
}

export type AuthorizedPublishContext =
  | {
      ok: true;
      caption: string;
      instagramUserId: string;
      facebookPageId: string;
    }
  | { ok: false; reason: "incomplete" | "targets_changed" };

/**
 * Resolves only the immutable snapshot captured by the human publish action.
 * `proposedCaption` is intentionally present but never returned: even if it
 * drifted later, the authorized copy is the only copy the worker may use.
 */
export function resolveAuthorizedPublishContext(
  record: AuthorizedPublishRecord,
  currentTargets: CurrentPublishTargets,
): AuthorizedPublishContext {
  if (
    record.status !== "approved" ||
    !record.authorizedAt ||
    !record.authorizedCaption ||
    !record.authorizedInstagramUserId ||
    !record.authorizedFacebookPageId
  ) {
    return { ok: false, reason: "incomplete" };
  }
  if (
    record.authorizedInstagramUserId !== currentTargets.instagramUserId ||
    record.authorizedFacebookPageId !== currentTargets.facebookPageId
  ) {
    return { ok: false, reason: "targets_changed" };
  }
  return {
    ok: true,
    caption: record.authorizedCaption,
    instagramUserId: record.authorizedInstagramUserId,
    facebookPageId: record.authorizedFacebookPageId,
  };
}
