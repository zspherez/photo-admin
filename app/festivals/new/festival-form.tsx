"use client";

import { useActionState } from "react";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { LinkButton } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Field, TextArea } from "@/components/ui/field";
import { createFestival } from "./actions";
import { INITIAL_FESTIVAL_FORM_STATE } from "./form-state";

function candidateLabel(candidate: {
  id: string;
  name: string;
  spotifyId: string | null;
  statsfmId: string | null;
  edmtrainId: number | null;
}): string {
  const identities = [
    candidate.spotifyId ? `Spotify ${candidate.spotifyId}` : null,
    candidate.statsfmId ? `Stats.fm ${candidate.statsfmId}` : null,
    candidate.edmtrainId ? `EDMTrain ${candidate.edmtrainId}` : null,
  ].filter(Boolean);
  return `${candidate.name} — ${
    identities.length > 0
      ? identities.join(" · ")
      : `record ${candidate.id.slice(-8)}`
  }`;
}

export function FestivalForm({ returnTo = "/festivals" }: { returnTo?: string }) {
  const [state, formAction] = useActionState(
    createFestival,
    INITIAL_FESTIVAL_FORM_STATE
  );

  return (
    <>
      {state.message && (
        <div
          role="alert"
          aria-live="polite"
          className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
        >
          {state.message}
        </div>
      )}

      <Card className="mt-6">
        <CardBody>
          <form action={formAction} className="space-y-4">
            <input type="hidden" name="returnTo" value={returnTo} />
            <Field
              name="name"
              label="Festival name"
              placeholder="ARC Music Festival 2026"
              defaultValue={state.values.name}
              required
            />
            <div className="grid grid-cols-2 gap-3">
              <Field
                name="date"
                label="Date"
                type="date"
                defaultValue={state.values.date}
                required
              />
              <Field
                name="state"
                label="State"
                placeholder="IL"
                defaultValue={state.values.state}
              />
            </div>
            <Field
              name="countryCode"
              label="Country code"
              placeholder="US"
              description="Two-letter ISO code, such as US, CA, MX, or GB. Defaults to United States."
              defaultValue={state.values.countryCode}
              required
            />
            <Field
              name="venueName"
              label="Venue"
              placeholder="Union Park"
              defaultValue={state.values.venueName}
              required
            />
            <Field
              name="city"
              label="City"
              placeholder="Chicago"
              defaultValue={state.values.city}
              required
            />
            <TextArea
              name="lineup"
              label="Lineup"
              description="At least one artist is required. Unique normalized matches are reused; ambiguous matches require your selection."
              rows={12}
              defaultValue={state.values.lineup}
              placeholder={"Solomun\nAdam Beyer\nDixon\nAdriatique\n..."}
              mono
            />

            {state.ambiguities.length > 0 && (
              <fieldset className="space-y-3 rounded-lg border border-amber-200 bg-amber-50/60 p-4 dark:border-amber-900 dark:bg-amber-950/20">
                <legend className="px-1 text-sm font-semibold">
                  Choose ambiguous artists
                </legend>
                {state.ambiguities.map((ambiguity) => (
                  <div key={ambiguity.selectionKey}>
                    <label
                      htmlFor={ambiguity.selectionKey}
                      className="text-sm font-medium"
                    >
                      {ambiguity.lineupName}
                    </label>
                    <select
                      id={ambiguity.selectionKey}
                      name={ambiguity.selectionKey}
                      defaultValue={ambiguity.selectedId}
                      required
                      className="mt-1 block w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-zinc-400 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
                    >
                      <option value="">Select the existing artist…</option>
                      {ambiguity.candidates.map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>
                          {candidateLabel(candidate)}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </fieldset>
            )}

            <div className="flex gap-2">
              <PendingSubmitButton
                variant="primary"
                pendingLabel="Creating festival…"
              >
                Create festival
              </PendingSubmitButton>
              <LinkButton href={returnTo} variant="secondary">
                Cancel
              </LinkButton>
            </div>
          </form>
        </CardBody>
      </Card>
    </>
  );
}
