"use client";

import { useActionState } from "react";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { Field, TextArea } from "@/components/ui/field";
import {
  addManualFestivalArtist,
  addManualFestivalArtists,
} from "./manual-lineup-actions";
import {
  INITIAL_BULK_MANUAL_FESTIVAL_ARTIST_STATE,
  INITIAL_MANUAL_FESTIVAL_ARTIST_STATE,
} from "./manual-lineup-state";

function candidateLabel(candidate: {
  id: string;
  name: string;
  spotifyId: string | null;
  statsfmId: string | null;
  edmtrainId: number | null;
  onLineup: boolean;
  manuallyAdded: boolean;
}): string {
  const identities = [
    candidate.spotifyId ? `Spotify ${candidate.spotifyId}` : null,
    candidate.statsfmId ? `Stats.fm ${candidate.statsfmId}` : null,
    candidate.edmtrainId ? `EDMTrain ${candidate.edmtrainId}` : null,
  ].filter(Boolean);
  const identity =
    identities.length > 0
      ? identities.join(" · ")
      : `record ${candidate.id.slice(-8)}`;
  return `${candidate.name} — ${identity}${
    candidate.onLineup ? " · already on lineup" : ""
  }`;
}

export function ManualFestivalArtistForm({
  showId,
  returnTo,
}: {
  showId: string;
  returnTo: string;
}) {
  const [state, formAction] = useActionState(
    addManualFestivalArtist,
    INITIAL_MANUAL_FESTIVAL_ARTIST_STATE,
  );

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="showId" value={showId} />
      <input type="hidden" name="returnTo" value={returnTo} />
      <Field
        name="artistName"
        label="Artist name"
        description="Exact normalized matches reuse the canonical artist. If no match exists, a manual artist is created."
        placeholder="Artist missing from EDMTrain"
        defaultValue={state.artistName}
        required
      />
      {state.ambiguities.length > 0 && (
        <div>
          <label htmlFor="artistChoice" className="text-sm font-medium">
            Choose the existing artist
          </label>
          <select
            id="artistChoice"
            name="artistChoice"
            defaultValue=""
            required
            className="mt-1 block min-h-11 w-full rounded-md border border-amber-300 bg-white px-3 py-2 text-base focus:border-amber-500 focus:outline-none sm:min-h-9 sm:text-sm dark:border-amber-800 dark:bg-zinc-950"
          >
            <option value="">Select an artist…</option>
            {state.ambiguities.map((candidate) => (
              <option
                key={candidate.id}
                value={candidate.id}
              >
                {candidateLabel(candidate)}
              </option>
            ))}
          </select>
        </div>
      )}
      {state.message && (
        <p
          role="alert"
          aria-live="polite"
          className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
        >
          {state.message}
        </p>
      )}
      <PendingSubmitButton pendingLabel="Adding artist…">
        Add to lineup
      </PendingSubmitButton>
    </form>
  );
}

export function BulkManualFestivalArtistForm({
  showId,
  returnTo,
}: {
  showId: string;
  returnTo: string;
}) {
  const [state, formAction] = useActionState(
    addManualFestivalArtists,
    INITIAL_BULK_MANUAL_FESTIVAL_ARTIST_STATE,
  );

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="showId" value={showId} />
      <input type="hidden" name="returnTo" value={returnTo} />
      <TextArea
        name="artistNames"
        label="Artist names"
        description="Paste one artist per line. Duplicate names and artists already on the lineup are merged, not duplicated."
        placeholder={"Artist One\nArtist Two\nArtist Three"}
        rows={8}
        defaultValue={state.artistNames}
        maxLength={60_000}
        required
      />
      {state.message && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900"
        >
          <p>{state.message}</p>
          {(state.addedCount > 0 ||
            state.preservedCount > 0 ||
            state.existingCount > 0 ||
            state.duplicateCount > 0) && (
            <p className="mt-1 text-xs text-zinc-500">
              {state.addedCount} added · {state.preservedCount} existing EDMTrain
              entries preserved manually · {state.existingCount} already
              manual · {state.duplicateCount} duplicate input
              {state.duplicateCount === 1 ? "" : "s"} skipped
            </p>
          )}
          {state.ambiguousNames.length > 0 && (
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
              Ambiguous: {state.ambiguousNames.join(", ")}
            </p>
          )}
        </div>
      )}
      <PendingSubmitButton pendingLabel="Merging artists…">
        Merge artist list into lineup
      </PendingSubmitButton>
    </form>
  );
}
