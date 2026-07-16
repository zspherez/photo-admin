"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { PendingSubmitButton } from "@/components/pending-submit-button";

type FormAction = (formData: FormData) => void | Promise<void>;

function SmsButton({
  phone,
  phoneContactName,
  emailContactName,
  emailAvailable,
  disabled,
}: {
  phone: string | null;
  phoneContactName: string | null;
  emailContactName: string | null;
  emailAvailable: boolean;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const hasPhone = Boolean(phone?.trim());

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  if (!hasPhone) return null;

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        Text
      </Button>
      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onClose={() => setOpen(false)}
        onClick={(event) => {
          if (event.target === dialogRef.current) dialogRef.current.close();
        }}
        className="m-auto w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-0 text-zinc-900 shadow-xl backdrop:bg-black/40 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
      >
        <div className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl dark:bg-zinc-900">
          <h2 id={titleId} className="text-sm font-semibold">
            Text {phoneContactName ?? emailContactName ?? "contact"}
          </h2>
          <p id={descriptionId} className="mt-1 text-xs text-zinc-500">
            Open your messaging app for {phone}.{" "}
            {emailAvailable
              ? "Email remains available as a separate outreach option."
              : "No email address is available for this artist."}
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              autoFocus
              onClick={() => dialogRef.current?.close()}
            >
              Cancel
            </Button>
            <a
              href={`sms:${phone}`}
              className="inline-flex h-7 items-center rounded-md bg-zinc-900 px-2.5 text-xs font-medium text-white hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:ring-offset-2 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
              onClick={() => dialogRef.current?.close()}
            >
              Open Messages
            </a>
          </div>
        </div>
      </dialog>
    </>
  );
}

export function SendButton({
  showId,
  contactId,
  contactName,
  phone,
  phoneContactName,
  alreadySent,
  emailDisabledLabel,
  emailDisabledReason,
  isRetry,
  isWeekend,
  scheduledInfo,
  returnTo,
  action,
  cancelAction,
}: {
  showId: string;
  contactId: string | null;
  contactName: string | null;
  phone: string | null;
  phoneContactName?: string | null;
  alreadySent: boolean;
  emailDisabledLabel?: string;
  emailDisabledReason?: string;
  isRetry?: boolean;
  isWeekend?: boolean;
  scheduledInfo?: { outreachId: string; scheduledLabel: string } | null;
  returnTo?: string;
  action: FormAction;
  cancelAction?: FormAction;
}) {
  if (scheduledInfo) {
    return (
      <div className="flex items-center gap-1.5">
        <span className="inline-flex items-center gap-1 rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900">
          <svg className="h-3 w-3" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0zm.5 4.5v4l3 1.5-.5 1-3.5-1.75V4.5h1z" />
          </svg>
          {scheduledInfo.scheduledLabel}
        </span>
        {cancelAction && (
          <form action={cancelAction}>
            <input type="hidden" name="outreachId" value={scheduledInfo.outreachId} />
            {returnTo && (
              <input type="hidden" name="returnTo" value={returnTo} />
            )}
            <PendingSubmitButton
              variant="danger"
              size="sm"
              pendingLabel="Cancelling…"
              className="h-6 px-2 text-[10px]"
            >
              Cancel
            </PendingSubmitButton>
          </form>
        )}
        <SmsButton
          phone={phone}
          phoneContactName={phoneContactName ?? null}
          emailContactName={contactName}
          emailAvailable={Boolean(contactId)}
          disabled={alreadySent}
        />
      </div>
    );
  }

  const buttonLabel = alreadySent
    ? "Sent"
    : emailDisabledLabel
      ? emailDisabledLabel
      : !contactId
        ? "No email"
        : isRetry
          ? isWeekend
            ? "Schedule retry"
            : "Retry"
        : isWeekend
          ? "Schedule Mon"
          : "Send";
  const pendingLabel = isRetry
    ? isWeekend
      ? "Scheduling retry…"
      : "Retrying…"
    : isWeekend
      ? "Scheduling…"
      : "Sending…";

  return (
    <div className="flex items-center gap-1.5">
      <form action={action}>
        <input type="hidden" name="showId" value={showId} />
        {contactId && (
          <input type="hidden" name="contactId" value={contactId} />
        )}
        {returnTo && (
          <input type="hidden" name="returnTo" value={returnTo} />
        )}
        <PendingSubmitButton
          variant="primary"
          size="sm"
          disabled={alreadySent || Boolean(emailDisabledLabel) || !contactId}
          pendingLabel={pendingLabel}
          title={
            emailDisabledReason
              ? emailDisabledReason
              : emailDisabledLabel
                ? "Resolve the existing outreach state before sending again"
              : !contactId
                ? "Add an email address before sending email outreach"
                : undefined
          }
        >
          {buttonLabel}
        </PendingSubmitButton>
      </form>

      <SmsButton
        phone={phone}
        phoneContactName={phoneContactName ?? null}
        emailContactName={contactName}
        emailAvailable={Boolean(contactId)}
        disabled={alreadySent}
      />
    </div>
  );
}
