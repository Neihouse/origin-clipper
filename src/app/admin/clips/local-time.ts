export const PUBLISH_TIME_ZONE = "America/Los_Angeles";
export const PUBLISH_TIME_ZONE_LABEL = "Pacific time (America/Los_Angeles)";
export const MIN_SCHEDULE_LEAD_MINUTES = 5;
export const SCHEDULE_HORIZON_DAYS = 28;

interface LocalDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function parseLocalDateTime(value: string): LocalDateTimeParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;

  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  };

  const normalized = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute),
  );
  if (
    normalized.getUTCFullYear() !== parts.year ||
    normalized.getUTCMonth() !== parts.month - 1 ||
    normalized.getUTCDate() !== parts.day ||
    normalized.getUTCHours() !== parts.hour ||
    normalized.getUTCMinutes() !== parts.minute
  ) {
    return null;
  }

  return parts;
}

function partsInTimeZone(value: Date, timeZone: string): LocalDateTimeParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);

  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type)?.value;
    if (!part) throw new Error(`Could not read ${type} in ${timeZone}.`);
    return Number(part);
  };

  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
  };
}

function timeZoneOffsetMilliseconds(value: Date, timeZone: string): number {
  const parts = partsInTimeZone(value, timeZone);
  const representedAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
  );
  const instantAtMinutePrecision = Math.floor(value.getTime() / 60_000) * 60_000;
  return representedAsUtc - instantAtMinutePrecision;
}

function equalParts(left: LocalDateTimeParts, right: LocalDateTimeParts): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute
  );
}

/**
 * Converts the wall-clock value from a datetime-local input into one unambiguous
 * instant. Both nonexistent spring-forward times and repeated fall-back times
 * are rejected instead of silently shifting the operator's chosen publish time.
 */
export function zonedLocalDateTimeToIso(
  value: string,
  timeZone = PUBLISH_TIME_ZONE,
): { iso: string } | { error: string } {
  const local = parseLocalDateTime(value);
  if (!local) return { error: "Choose a valid date and time." };

  const wallClockAsUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
  );
  const offsets = new Set<number>();
  for (const deltaHours of [-36, -12, 0, 12, 36]) {
    offsets.add(
      timeZoneOffsetMilliseconds(new Date(wallClockAsUtc + deltaHours * 60 * 60 * 1000), timeZone),
    );
  }

  const candidates = [...offsets]
    .map((offset) => new Date(wallClockAsUtc - offset))
    .filter((candidate) => equalParts(partsInTimeZone(candidate, timeZone), local));
  const uniqueCandidates = [...new Map(candidates.map((candidate) => [candidate.getTime(), candidate])).values()];

  if (uniqueCandidates.length === 0) {
    return {
      error: "That local time does not exist because the Pacific clock moves forward. Choose another time.",
    };
  }
  if (uniqueCandidates.length > 1) {
    return {
      error: "That local time occurs twice because the Pacific clock moves back. Choose another time.",
    };
  }

  return { iso: uniqueCandidates[0]!.toISOString() };
}

export function toZonedDateTimeInputValue(
  value: Date | string,
  timeZone = PUBLISH_TIME_ZONE,
): string {
  const parts = partsInTimeZone(new Date(value), timeZone);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

export function formatZonedDateTime(
  value: Date | string,
  timeZone = PUBLISH_TIME_ZONE,
): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}

export function scheduleInputBounds(now = new Date()): {
  min: string;
  max: string;
  suggested: string;
} {
  const minInstant = new Date(now.getTime() + MIN_SCHEDULE_LEAD_MINUTES * 60_000);
  const maxInstant = new Date(now.getTime() + SCHEDULE_HORIZON_DAYS * 24 * 60 * 60_000);
  const suggestedInstant = new Date(now.getTime() + 24 * 60 * 60_000);

  // Round the suggestion up to the next quarter-hour so the default is easy to scan.
  suggestedInstant.setUTCSeconds(0, 0);
  suggestedInstant.setUTCMinutes(Math.ceil(suggestedInstant.getUTCMinutes() / 15) * 15);

  return {
    min: toZonedDateTimeInputValue(minInstant),
    max: toZonedDateTimeInputValue(maxInstant),
    suggested: toZonedDateTimeInputValue(suggestedInstant),
  };
}
