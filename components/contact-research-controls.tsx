import { PendingSubmitButton } from "@/components/pending-submit-button";
import { TextArea } from "@/components/ui/field";

type ResearchAction = (formData: FormData) => void | Promise<void>;

export interface ActiveArtistResearchSkip {
  source: string;
  reason: string;
  setAt: Date;
  agentRuleVersion: number | null;
  agentRuleText: string | null;
}

interface ContactResearchControlsProps {
  idPrefix: string;
  userNotes: string | null;
  activeSkip: ActiveArtistResearchSkip | null;
  saveAction: ResearchAction;
  skipAction: ResearchAction;
  unskipAction: ResearchAction;
  hiddenFields?: ReadonlyArray<{ name: string; value: string }>;
  canManage?: boolean;
  hasJob?: boolean;
  unavailableMessage?: string;
  notesDescription?: string;
}

function HiddenFields({
  fields,
}: {
  fields: ReadonlyArray<{ name: string; value: string }>;
}) {
  return fields.map((field) => (
    <input
      key={field.name}
      type="hidden"
      name={field.name}
      value={field.value}
    />
  ));
}

export function ContactResearchControls({
  idPrefix,
  userNotes,
  activeSkip,
  saveAction,
  skipAction,
  unskipAction,
  hiddenFields = [],
  canManage = true,
  hasJob = true,
  unavailableMessage,
  notesDescription = "Trusted artist-specific context for the research agent. Use the intentional skip control below when research must stop until you explicitly restore it.",
}: ContactResearchControlsProps) {
  if (!canManage) {
    return unavailableMessage ? (
      <p className="rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
        {unavailableMessage}
      </p>
    ) : null;
  }

  return (
    <div className="space-y-3">
      <form action={saveAction}>
        <HiddenFields fields={hiddenFields} />
        <TextArea
          id={`${idPrefix}-user-notes`}
          name="userNotes"
          label="Research instructions"
          description={notesDescription}
          rows={3}
          defaultValue={userNotes ?? ""}
          required={!hasJob}
          placeholder="Example: Prioritize the management team listed on the official website."
        />
        <PendingSubmitButton
          variant="secondary"
          size="sm"
          pendingLabel="Saving…"
          className="mt-2"
        >
          Save instructions
        </PendingSubmitButton>
      </form>

      {activeSkip ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
          <p className="text-xs font-semibold uppercase tracking-wide">
            Intentionally skipped
          </p>
          <p className="mt-1 text-sm font-medium">{activeSkip.reason}</p>
          <p className="mt-2 text-xs text-amber-800 dark:text-amber-300">
            {activeSkip.source === "agent"
              ? `Set by contact-research agent from trusted global rules version ${activeSkip.agentRuleVersion}`
              : "Set manually"}
            {" · "}
            {activeSkip.setAt.toLocaleString("en-US", {
              timeZone: "America/New_York",
            })}
          </p>
          {activeSkip.agentRuleText && (
            <p className="mt-2 border-l-2 border-amber-400 pl-2 text-xs">
              Rule: {activeSkip.agentRuleText}
            </p>
          )}
          <form action={unskipAction} className="mt-3">
            <HiddenFields fields={hiddenFields} />
            <PendingSubmitButton
              variant="secondary"
              size="sm"
              pendingLabel="Restoring…"
            >
              Unskip and restore eligibility
            </PendingSubmitButton>
          </form>
        </div>
      ) : (
        <form action={skipAction}>
          <HiddenFields fields={hiddenFields} />
          <TextArea
            id={`${idPrefix}-skip-reason`}
            name="reason"
            label="Intentional skip reason"
            description="Required audit note. This suppresses queue refreshes, requeues, and agent claims until you explicitly unskip the artist."
            rows={3}
            maxLength={4_000}
            required
            placeholder="Example: Existing relationship — do not research automatically."
          />
          <PendingSubmitButton
            variant="secondary"
            size="sm"
            pendingLabel="Skipping…"
            className="mt-2"
          >
            Intentionally skip artist
          </PendingSubmitButton>
        </form>
      )}
    </div>
  );
}
