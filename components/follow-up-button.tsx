import { PendingSubmitButton } from "@/components/pending-submit-button";
import { LinkButton } from "@/components/ui/button";
import { appConfig } from "@/lib/appConfig";
import { isCancellableOutreachStatus } from "@/lib/outreachStatus";
import type { FollowUpEligibility } from "@/lib/sendOutreach";
import { OUTREACH_MORNING_DISPATCH_LABEL } from "@/lib/schedule";
import { withWorkflowReturnTo } from "@/lib/workflowLinks";

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
  showId: string;
  hiddenFields?: readonly HiddenField[];
}) {
  const customizeParams = new URLSearchParams({
    parentOutreachId: eligibility.parentOutreachId,
  });
  for (const field of hiddenFields) {
    customizeParams.set(field.name, field.value);
  }
  const customizeHref = eligibility.contactId
    ? withWorkflowReturnTo(
        `/dashboard/customize/${encodeURIComponent(
          showId,
        )}/${encodeURIComponent(eligibility.contactId)}?${customizeParams}`,
        returnTo,
      )
    : null;

  if (eligibility.eligible) {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        {customizeHref && (
          <LinkButton href={customizeHref} variant="secondary" size="sm">
            Customize
          </LinkButton>
        )}
        <form action={action}>
          <input
            type="hidden"
            name="parentOutreachId"
            value={eligibility.parentOutreachId}
          />
          <input type="hidden" name="returnTo" value={returnTo} />
          <input type="hidden" name="intent" value="send" />
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
        <form action={action}>
          <input
            type="hidden"
            name="parentOutreachId"
            value={eligibility.parentOutreachId}
          />
          <input type="hidden" name="returnTo" value={returnTo} />
          <input type="hidden" name="intent" value="queue" />
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
            pendingLabel="Scheduling follow-up…"
          >
            Schedule {OUTREACH_MORNING_DISPATCH_LABEL}
          </PendingSubmitButton>
        </form>
      </div>
    );
  }

  if (
    eligibility.state === "pending" &&
    eligibility.followUpOutreachId
  ) {
    return (
      <div className="flex items-center gap-1.5">
        {customizeHref && (
          <LinkButton href={customizeHref} variant="secondary" size="sm">
            Customize
          </LinkButton>
        )}
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
                timeZone: appConfig.timeZone,
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
      <div className="flex flex-wrap items-center gap-1.5">
        {customizeHref && (
          <LinkButton href={customizeHref} variant="secondary" size="sm">
            Customize
          </LinkButton>
        )}
        <span className="text-xs font-medium text-emerald-700 dark:text-emerald-300">
          Follow-up sent
        </span>
      </div>
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
