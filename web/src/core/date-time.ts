export type TimestampStyle = "full" | "compact";

const FULL_TIMESTAMP = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const COMPACT_TIMESTAMP = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export function formatUtc8Timestamp(
  timestampSeconds: number,
  style: TimestampStyle = "full",
): string {
  const formatter =
    style === "compact" ? COMPACT_TIMESTAMP : FULL_TIMESTAMP;
  return formatter.format(new Date(timestampSeconds * 1000));
}
