"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export function SendButton({
  showId,
  contactId,
  contactName,
  phone,
  alreadySent,
  action,
}: {
  showId: string;
  contactId: string;
  contactName: string | null;
  phone: string | null;
  alreadySent: boolean;
  action: (formData: FormData) => void;
}) {
  const [open, setOpen] = useState(false);
  const hasPhone = !!phone?.trim();

  if (!hasPhone) {
    return (
      <form action={action}>
        <input type="hidden" name="showId" value={showId} />
        <input type="hidden" name="contactId" value={contactId} />
        <Button type="submit" variant="primary" size="sm" disabled={alreadySent}>
          {alreadySent ? "Sent" : "Send"}
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
        {alreadySent ? "Sent" : "Send"}
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
