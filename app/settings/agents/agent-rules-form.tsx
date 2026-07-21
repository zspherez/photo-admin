"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import {
  DIRECT_OUTREACH_INSTRUCTIONS_MAX_LENGTH,
  GLOBAL_AGENT_RULES_MAX_LENGTH,
} from "@/lib/agentRuleConstants";
import { saveAgentRulesAction } from "./actions";
import type { AgentRulesFormState } from "./form-state";

const INPUT_CLASS =
  "mt-1 block w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:border-zinc-800 dark:bg-zinc-950 dark:placeholder:text-zinc-600";

function describedBy(...ids: Array<string | false | undefined>) {
  const value = ids.filter(Boolean).join(" ");
  return value || undefined;
}

export function AgentRulesForm({
  initialState,
  version,
}: {
  initialState: AgentRulesFormState;
  version: number;
}) {
  const [state, formAction, pending] = useActionState(
    saveAgentRulesAction,
    initialState,
  );

  return (
    <form action={formAction} className="space-y-6" aria-busy={pending}>
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
          Global agent rules
        </label>
        <p id="instructions-description" className="mt-1 text-xs text-zinc-500">
          Scope: all agent jobs. Maximum{" "}
          {GLOBAL_AGENT_RULES_MAX_LENGTH.toLocaleString()} characters.
          Artist-specific research notes remain separate and apply only to that
          artist.
        </p>
        <textarea
          id="instructions"
          name="instructions"
          rows={10}
          maxLength={GLOBAL_AGENT_RULES_MAX_LENGTH}
          defaultValue={state.values.instructions}
          placeholder="Example: Prefer official artist and management-company sources. Explain uncertainty explicitly."
          aria-invalid={Boolean(state.fieldErrors.instructions)}
          aria-describedby={describedBy(
            "instructions-description",
            state.fieldErrors.instructions && "instructions-error",
          )}
          className={INPUT_CLASS}
        />
        {state.fieldErrors.instructions && (
          <p id="instructions-error" className="mt-1 text-xs text-red-600">
            {state.fieldErrors.instructions}
          </p>
        )}
      </div>

      <div className="border-t border-zinc-200 pt-6 dark:border-zinc-800">
        <label
          htmlFor="directOutreachInstructions"
          className="text-sm font-medium"
        >
          Direct outreach rules
        </label>
        <p
          id="direct-outreach-description"
          className="mt-1 text-xs text-zinc-500"
        >
          Write trusted direct-outreach instructions in ordinary language.
          These instructions may only create a pending proposal for human
          review. Never enter a phone number; say that a number is already on
          file instead.
        </p>
        <textarea
          id="directOutreachInstructions"
          name="directOutreachInstructions"
          rows={7}
          maxLength={DIRECT_OUTREACH_INSTRUCTIONS_MAX_LENGTH}
          defaultValue={state.values.directOutreachInstructions}
          placeholder="When an artist is managed by Leif Fosse, add a direct outreach note that I have his number."
          aria-invalid={Boolean(
            state.fieldErrors.directOutreachInstructions,
          )}
          aria-describedby={describedBy(
            "direct-outreach-description",
            state.fieldErrors.directOutreachInstructions &&
              "direct-outreach-error",
          )}
          className={INPUT_CLASS}
        />
        {state.fieldErrors.directOutreachInstructions && (
          <p
            id="direct-outreach-error"
            className="mt-1 text-xs text-red-600"
          >
            {state.fieldErrors.directOutreachInstructions}
          </p>
        )}
      </div>

      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
        General rules cannot authorize direct outreach. The server records the
        exact relevant direct-outreach instruction from the claimed snapshot,
        and a person must approve the resulting proposal before any contact
        note is created or changed.
      </div>
      <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-400">
        Saving creates a new version for future claims. Jobs already claimed
        keep their exact snapshotted instructions and claim token; pending,
        expired, or requeued jobs receive the latest version when next claimed.
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
          {pending ? "Saving rules…" : "Save rules"}
        </Button>
      </div>
    </form>
  );
}
