"use client";

import { useMemo, useState } from "react";
import {
  normalizeProfessionalPersonNames,
  PROFESSIONAL_CONTACT_LIMITS,
} from "@/lib/professionalContactInput";
import { Button } from "@/components/ui/button";

export function ProfessionalContactRequestForm({
  action,
}: {
  action: (formData: FormData) => void | Promise<void>;
}) {
  const [organizationName, setOrganizationName] = useState("");
  const [website, setWebsite] = useState("");
  const [locationContext, setLocationContext] = useState("");
  const [notes, setNotes] = useState("");
  const [personNames, setPersonNames] = useState("");
  const scope = useMemo(() => {
    try {
      return {
        people: normalizeProfessionalPersonNames(personNames),
        error: null,
      };
    } catch (error) {
      return {
        people: [],
        error:
          personNames.trim() && error instanceof Error ? error.message : null,
      };
    }
  }, [personNames]);
  const ready = organizationName.trim().length >= 2 && scope.people.length > 0;

  return (
    <form action={action} className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1 text-sm font-medium">
          <span>Organization or company</span>
          <input
            name="organizationName"
            value={organizationName}
            onChange={(event) => setOrganizationName(event.target.value)}
            required
            maxLength={PROFESSIONAL_CONTACT_LIMITS.organization}
            autoComplete="organization"
            className="min-h-11 w-full rounded-md border border-zinc-300 bg-white px-3 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            placeholder="LED Presents"
          />
        </label>
        <label className="space-y-1 text-sm font-medium">
          <span>Official website (optional)</span>
          <input
            name="website"
            type="url"
            value={website}
            onChange={(event) => setWebsite(event.target.value)}
            maxLength={PROFESSIONAL_CONTACT_LIMITS.website}
            className="min-h-11 w-full rounded-md border border-zinc-300 bg-white px-3 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            placeholder="https://ledpresents.com/"
          />
        </label>
      </div>
      <label className="block space-y-1 text-sm font-medium">
        <span>Location or context (optional)</span>
        <input
          name="locationContext"
          value={locationContext}
          onChange={(event) => setLocationContext(event.target.value)}
          maxLength={PROFESSIONAL_CONTACT_LIMITS.locationContext}
          className="min-h-11 w-full rounded-md border border-zinc-300 bg-white px-3 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          placeholder="San Diego; founders and executive team"
        />
      </label>
      <label className="block space-y-1 text-sm font-medium">
        <span>Person names, one per line</span>
        <textarea
          name="personNames"
          value={personNames}
          onChange={(event) => setPersonNames(event.target.value)}
          required
          maxLength={PROFESSIONAL_CONTACT_LIMITS.namesText}
          rows={6}
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          placeholder={"John Doe\nJane Smith"}
        />
        <span className="block text-xs font-normal text-zinc-500">
          Duplicate names are removed. Maximum {PROFESSIONAL_CONTACT_LIMITS.people} people.
        </span>
      </label>
      <label className="block space-y-1 text-sm font-medium">
        <span>Research notes (optional)</span>
        <textarea
          name="notes"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          maxLength={PROFESSIONAL_CONTACT_LIMITS.notes}
          rows={3}
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          placeholder="Public professional/business addresses only."
        />
      </label>

      <section
        aria-label="Exact submitted scope"
        className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900/40"
      >
        <h3 className="text-sm font-semibold">Exact submitted scope</h3>
        <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-[10rem_1fr]">
          <dt className="text-zinc-500">Organization</dt>
          <dd>{organizationName.trim() || "Not entered"}</dd>
          <dt className="text-zinc-500">Website</dt>
          <dd>{website.trim() || "Not provided"}</dd>
          <dt className="text-zinc-500">Location/context</dt>
          <dd>{locationContext.trim() || "Not provided"}</dd>
          <dt className="text-zinc-500">Notes</dt>
          <dd>{notes.trim() || "Not provided"}</dd>
          <dt className="text-zinc-500">People ({scope.people.length})</dt>
          <dd>
            {scope.people.length > 0 ? (
              <ul className="list-inside list-disc">
                {scope.people.map((person) => (
                  <li key={person.toLocaleLowerCase()}>{person}</li>
                ))}
              </ul>
            ) : (
              "No valid names yet"
            )}
          </dd>
        </dl>
        {scope.error && (
          <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300">
            {scope.error}
          </p>
        )}
      </section>
      <Button type="submit" disabled={!ready}>
        Confirm and queue {scope.people.length || ""}{" "}
        {scope.people.length === 1 ? "person" : "people"}
      </Button>
    </form>
  );
}
