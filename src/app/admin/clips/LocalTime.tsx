import { formatZonedDateTime, PUBLISH_TIME_ZONE } from "./local-time";

export function LocalTime({ value, className }: { value: string; className?: string }) {
  return (
    <time dateTime={value} className={className}>
      {formatZonedDateTime(value, PUBLISH_TIME_ZONE)}
    </time>
  );
}
