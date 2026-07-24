"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { GLOBAL_AGENT_RULES_MAX_LENGTH } from "@/lib/agentRuleConstants";
import { saveAuditAgentRulesAction } from "./actions";
import type { AuditAgentRulesFormState } from "./form-state";

const INPUT_CLASS =
  "mt-1 block w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:border-zinc-800 dark:bg-zinc-950 dark:placeholder:text-zinc-600";

export function AuditAgentRulesForm({
  initialState,
  version,
}: {
  initialState: AuditAgentRulesFormState;
  version: number;
}) {
  const [state, formAction, pending] = useActionState(
    saveAuditAgentRulesAction,
    initialState,
  );

  return (
    <form action={formAction} className="space-y-5" aria-busy={pending}>
      {state.message && (
        <div
          role="alert"
          aria-live="polite"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
        >
          {state.message}
        </div>
      )}
      <div>
        <label htmlFor="instructions" className="text-sm font-medium">
          Contact audit agent rules
        </label>
        <p
          id="audit-instructions-description"
          className="mt-1 text-xs text-zinc-500"
        >
          Trusted operator instructions added to every future contact audit
          claim. Maximum {GLOBAL_AGENT_RULES_MAX_LENGTH.toLocaleString()}{" "}
          characters. Canonical audit safety rules still take precedence.
        </p>
        <textarea
          id="instructions"
          name="instructions"
          rows={12}
          maxLength={GLOBAL_AGENT_RULES_MAX_LENGTH}
          defaultValue={state.values.instructions}
          placeholder="Example: Prioritize current official artist or management-company sources. Treat roster-wide company changes as one artist-level finding."
          aria-invalid={Boolean(state.fieldErrors.instructions)}
          aria-describedby="audit-instructions-description"
          className={INPUT_CLASS}
        />
        {state.fieldErrors.instructions && (
          <p className="mt-1 text-xs text-red-600">
            {state.fieldErrors.instructions}
          </p>
        )}
      </div>
      <label className="flex items-start gap-3 rounded-lg border border-zinc-200 p-4 text-sm dark:border-zinc-800">
        <input
          type="checkbox"
          name="autoAppendAdditionalContact"
          value="true"
          defaultChecked={state.values.autoAppendAdditionalContact}
          className="mt-0.5"
        />
        <span>
          <span className="font-medium">
            Auto-add confirmed additional manager contacts
          </span>
          <span className="mt-1 block text-xs text-zinc-500">
            Automatically append one new high-confidence management email when
            every stored roster contact is confirmed current or coexisting.
            Any stale, conflicting, ambiguous, or unverified roster result
            keeps the proposal in manual review.
          </span>
        </span>
      </label>
      <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-400">
        Saving creates a new version for future claims. Already claimed jobs
        keep their exact snapshot; pending, expired, or requeued jobs receive
        the latest version when claimed again.
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-zinc-500">
          Current version: {version || "not saved"}
        </p>
        <Button
          type="submit"
          variant="primary"
          disabled={pending}
          className="w-full sm:w-auto"
        >
          {pending ? "Saving rules…" : "Save audit rules"}
        </Button>
      </div>
    </form>
  );
}
