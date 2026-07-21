import { PendingSubmitButton } from "@/components/pending-submit-button";
import { isCancellableOutreachStatus } from "@/lib/outreachStatus";
import type { FollowUpEligibility } from "@/lib/sendOutreach";

type FormAction = (formData: FormData) => void | Promise<void>;
type HiddenField = { name: string; value: string };

export function FollowUpButton({
  eligibility,
  returnTo,
  isWeekend,
  action,
  cancelAction,
  showId,
  hiddenFields = [],
}: {
  eligibility: FollowUpEligibility;
  returnTo: string;
  isWeekend: boolean;
  action: FormAction;
  cancelAction?: FormAction;
  showId?: string;
  hiddenFields?: readonly HiddenField[];
}) {
  if (eligibility.eligible) {
    return (
      <form action={action}>
        <input
          type="hidden"
          name="parentOutreachId"
          value={eligibility.parentOutreachId}
        />
        <input type="hidden" name="returnTo" value={returnTo} />
        {hiddenFields.map((field) => (
          <input
            key={field.name}
            type="hidden"
            name={field.name}
            value={field.value}
          />
        ))}
        <PendingSubmitButton
          variant="secondary"
          size="sm"
          pendingLabel={
            isWeekend ? "Scheduling follow-up…" : "Sending follow-up…"
          }
        >
          {isWeekend ? "Schedule follow-up" : "Send follow-up"}
        </PendingSubmitButton>
      </form>
    );
  }

  if (
    eligibility.state === "pending" &&
    eligibility.followUpOutreachId
  ) {
    return (
      <div className="flex items-center gap-1.5">
        <span
          className="text-xs font-medium text-amber-700 dark:text-amber-300"
          title={eligibility.reason ?? undefined}
        >
          {eligibility.followUpStatus === "queued"
            ? "Follow-up in progress"
            : eligibility.followUpStatus === "retry_scheduled"
              ? "Follow-up retry scheduled"
              : "Follow-up scheduled"}
          {eligibility.nextAttemptAt
            ? ` · ${eligibility.nextAttemptAt.toLocaleString("en-US", {
                timeZone: "America/New_York",
                weekday: "short",
                hour: "numeric",
                minute: "2-digit",
                hour12: true,
              })}`
            : ""}
        </span>
        {cancelAction &&
          isCancellableOutreachStatus(eligibility.followUpStatus) && (
            <form action={cancelAction}>
              <input
                type="hidden"
                name="outreachId"
                value={eligibility.followUpOutreachId}
              />
              <input type="hidden" name="returnTo" value={returnTo} />
              {showId && (
                <input type="hidden" name="showId" value={showId} />
              )}
              {hiddenFields.map((field) => (
                <input
                  key={field.name}
                  type="hidden"
                  name={field.name}
                  value={field.value}
                />
              ))}
              <PendingSubmitButton
                variant="danger"
                size="sm"
                pendingLabel="Cancelling…"
              >
                Cancel
              </PendingSubmitButton>
            </form>
          )}
      </div>
    );
  }

  if (eligibility.state === "sent") {
    return (
      <span className="text-xs font-medium text-emerald-700 dark:text-emerald-300">
        Follow-up sent
      </span>
    );
  }

  return (
    <span
      className="text-xs text-zinc-500"
      title={eligibility.reason ?? undefined}
      aria-label={
        eligibility.reason
          ? `Follow-up unavailable: ${eligibility.reason}`
          : "Follow-up unavailable"
      }
    >
      Follow-up unavailable
    </span>
  );
}
