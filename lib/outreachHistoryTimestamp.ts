export function outreachHistoryTimestamp(
  outreach: {
    status: string;
    nextAttemptAt: Date | null;
    scheduledFor: Date | null;
    sentAt: Date | null;
    createdAt: Date;
  },
  timeZone: string,
): { date: Date; label: string; text: string } {
  const scheduled =
    outreach.status === "scheduled" || outreach.status === "retry_scheduled";
  const date = scheduled
    ? outreach.nextAttemptAt ?? outreach.scheduledFor ?? outreach.createdAt
    : outreach.sentAt ?? outreach.createdAt;
  const label =
    outreach.status === "retry_scheduled"
      ? "Next attempt"
      : scheduled
        ? "Scheduled"
        : outreach.sentAt
          ? "Sent"
          : "Created";
  return {
    date,
    label,
    text: date.toLocaleString("en-US", {
      timeZone,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }),
  };
}
