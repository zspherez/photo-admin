"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export function SendButton({
  showId,
  contactId,
  contactName,
  phone,
  alreadySent,
  isWeekend,
  scheduledInfo,
  action,
  cancelAction,
}: {
  showId: string;
  contactId: string;
  contactName: string | null;
  phone: string | null;
  alreadySent: boolean;
  isWeekend?: boolean;
  scheduledInfo?: { outreachId: string; scheduledLabel: string } | null;
  action: (formData: FormData) => void;
  cancelAction?: (formData: FormData) => void;
}) {
  const [open, setOpen] = useState(false);
  const hasPhone = !!phone?.trim();

  // If this outreach is scheduled, show the scheduled state with cancel
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
            <button
              type="submit"
              className="rounded-md px-1.5 py-0.5 text-[10px] font-medium text-red-600 hover:bg-red-50 hover:text-red-800 dark:text-red-400 dark:hover:bg-red-950/40 dark:hover:text-red-200"
            >
              Cancel
            </button>
          </form>
        )}
      </div>
    );
  }

  const buttonLabel = alreadySent ? "Sent" : isWeekend ? "Schedule Mon" : "Send";

  if (!hasPhone) {
    return (
      <form action={action}>
        <input type="hidden" name="showId" value={showId} />
        <input type="hidden" name="contactId" value={contactId} />
        <Button type="submit" variant="primary" size="sm" disabled={alreadySent}>
          {buttonLabel}
        </Button>
      </form>
    );
  }

  return (
    <>
      <Button
        type="button"
        variant="primary"
        size="sm"
        disabled={alreadySent}
        onClick={() => setOpen(true)}
      >
        {buttonLabel}
      </Button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl dark:bg-zinc-900"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-sm font-semibold">Text {contactName ?? "contact"}</h2>
            <p className="mt-1 text-xs text-zinc-500">
              This contact has a phone number on file ({phone}). Send a text instead of an email?
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(false)}>
                Dismiss
              </Button>
              <a
                href={`sms:${phone}`}
                className="inline-flex h-8 items-center rounded-md bg-zinc-900 px-3 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
                onClick={() => setOpen(false)}
              >
                Open Messages
              </a>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
