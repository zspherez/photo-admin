"use client";

import { useActionState } from "react";
import { sendArbitraryEmailAction } from "@/app/emails/actions";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { TemplateEditor } from "@/components/template-editor";

export function ComposeEmailForm({
  compositionId,
  queueLabel,
}: {
  compositionId: string;
  queueLabel: string;
}) {
  const [state, formAction] = useActionState(sendArbitraryEmailAction, {
    error: null,
  });

  return (
    <form action={formAction} className="space-y-6">
      <input type="hidden" name="compositionId" value={compositionId} />
      <div>
        <label htmlFor="recipients" className="text-sm font-medium">
          Recipients
        </label>
        <textarea
          id="recipients"
          name="recipients"
          required
          rows={2}
          placeholder="person@example.com, another@example.com"
          className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <p className="mt-1 text-xs text-zinc-500">
          Separate up to 50 addresses with commas, semicolons, or new lines.
        </p>
      </div>

      {state.error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
        >
          {state.error}
        </div>
      )}

      <TemplateEditor
        initialSubject=""
        initialHtml="<p></p>"
        variables={[]}
        previewNormalization="arbitrary-email"
      />
      <p className="-mt-4 text-xs text-zinc-500">
        Normalization avoids malformed MIME/HTML and improves mail-client
        compatibility. Inbox placement also depends on DNS authentication,
        sender reputation, content, and sending behavior. Paste rendered content
        or decoded HTML, not quoted-printable message source. Only safe web,
        email, and phone links and visible absolute web images are retained;
        unsafe schemes and hidden tracking pixels are removed.
      </p>

      <fieldset>
        <legend className="text-sm font-medium">UTM tags</legend>
        <p className="mt-1 text-xs text-zinc-500">
          Non-empty values are added to every HTTP or HTTPS link unless that link
          already specifies the same tag.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {[
            ["utm_source", "Source", "photo_admin"],
            ["utm_medium", "Medium", "email"],
            ["utm_campaign", "Campaign", ""],
            ["utm_content", "Content", ""],
            ["utm_term", "Term", ""],
          ].map(([name, label, defaultValue]) => (
            <label
              key={name}
              className="text-xs font-medium text-zinc-600 dark:text-zinc-400"
            >
              {label}
              <input
                name={name}
                defaultValue={defaultValue}
                maxLength={200}
                className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              />
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mobile-sticky-actions mobile-action-grid flex flex-wrap justify-end gap-2 sm:w-auto">
        <PendingSubmitButton
          name="intent"
          value="queue"
          variant="secondary"
          pendingLabel="Queueing…"
        >
          {queueLabel}
        </PendingSubmitButton>
        <PendingSubmitButton
          name="intent"
          value="send"
          pendingLabel="Sending…"
        >
          Send email
        </PendingSubmitButton>
      </div>
    </form>
  );
}
