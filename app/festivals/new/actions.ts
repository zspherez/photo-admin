"use server";

import { Prisma } from "@prisma/client";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { acquireArtistIdentityLock } from "@/lib/artistIdentity";
import {
  chooseFestivalLineupCandidate,
  dedupeFestivalArtistIds,
  type FestivalLineupEntry,
  type FestivalLineupDecision,
} from "@/lib/festivalLineup";
import { requireServerActionAuth } from "@/lib/auth";
import { DEFAULT_COUNTRY_CODE } from "@/lib/country";
import {
  festivalReturnPath,
  workflowReturnPath,
} from "@/lib/dashboardReturnUrl";
import { parseFestivalListView } from "@/lib/festivalView";
import type {
  FestivalArtistAmbiguity,
  FestivalFormState,
  FestivalFormValues,
} from "./form-state";
import { validateFestivalCreation } from "./validation";

class AmbiguousLineupError extends Error {
  constructor(readonly ambiguities: FestivalArtistAmbiguity[]) {
    super("Lineup artist selection is required");
    this.name = "AmbiguousLineupError";
  }
}

function formValue(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function readValues(formData: FormData): FestivalFormValues {
  return {
    name: formValue(formData, "name"),
    date: formValue(formData, "date"),
    venueName: formValue(formData, "venueName"),
    city: formValue(formData, "city"),
    state: formValue(formData, "state"),
    countryCode:
      formValue(formData, "countryCode") || DEFAULT_COUNTRY_CODE,
    lineup: String(formData.get("lineup") ?? "").trim(),
  };
}

function errorState(
  values: FestivalFormValues,
  message: string,
  ambiguities: FestivalArtistAmbiguity[] = []
): FestivalFormState {
  return { values, message, ambiguities };
}

async function persistFestival(
  values: FestivalFormValues,
  date: Date,
  countryCode: string,
  countryName: string,
  festivalNycStatus: "inside_nyc" | "outside_nyc" | "unknown",
  entries: FestivalLineupEntry[],
  selections: Map<string, string>
): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await db.$transaction(
        async (tx) => {
          await acquireArtistIdentityLock(tx);
          const candidates =
            entries.length === 0
              ? []
              : await tx.artist.findMany({
                  where: {
                    normalizedName: {
                      in: entries.map((entry) => entry.normalizedName),
                    },
                  },
                  orderBy: [{ normalizedName: "asc" }, { id: "asc" }],
                });
          const candidatesByName = new Map<
            string,
            typeof candidates
          >();
          for (const candidate of candidates) {
            const rows =
              candidatesByName.get(candidate.normalizedName) ?? [];
            rows.push(candidate);
            candidatesByName.set(candidate.normalizedName, rows);
          }

          const decisions: Array<{
            entry: FestivalLineupEntry;
            decision: FestivalLineupDecision<(typeof candidates)[number]>;
          }> = [];
          const ambiguityPrompts: FestivalArtistAmbiguity[] = [];
          let unresolved = false;
          for (const entry of entries) {
            const matches =
              candidatesByName.get(entry.normalizedName) ?? [];
            const selectedId = selections.get(entry.selectionKey) ?? "";
            const decision = chooseFestivalLineupCandidate(
              matches,
              selectedId || null
            );
            decisions.push({ entry, decision });
            if (matches.length > 1) {
              ambiguityPrompts.push({
                selectionKey: entry.selectionKey,
                lineupName: entry.name,
                selectedId:
                  decision.kind === "use" ? decision.candidate.id : "",
                candidates: matches.map((candidate) => ({
                  id: candidate.id,
                  name: candidate.name,
                  spotifyId: candidate.spotifyId,
                  statsfmId: candidate.statsfmId,
                  edmtrainId: candidate.edmtrainId,
                })),
              });
            }
            if (decision.kind === "ambiguous") unresolved = true;
          }

          if (unresolved) {
            throw new AmbiguousLineupError(ambiguityPrompts);
          }

          const artistIds: string[] = [];
          const createdArtistIdsByName = new Map<string, string>();
          for (const { entry, decision } of decisions) {
            if (decision.kind === "create") {
              const existingCreated = createdArtistIdsByName.get(
                entry.normalizedName
              );
              if (existingCreated) {
                artistIds.push(existingCreated);
                continue;
              }
              const artist = await tx.artist.create({
                data: {
                  name: entry.name,
                  normalizedName: entry.normalizedName,
                },
              });
              createdArtistIdsByName.set(entry.normalizedName, artist.id);
              artistIds.push(artist.id);
              continue;
            }
            if (decision.kind === "use") {
              artistIds.push(decision.candidate.id);
              continue;
            }
            throw new Error(
              `Unresolved lineup decision for ${entry.name}`
            );
          }

          const festival = await tx.show.create({
            data: {
              date,
              venueName: values.venueName,
              city: values.city,
              state: values.state || null,
              countryCode,
              countryName,
              isFestival: true,
              festivalNycStatus,
              eventName: values.name,
              source: "manual",
            },
          });
          const uniqueArtistIds = dedupeFestivalArtistIds(artistIds);
          if (uniqueArtistIds.length > 0) {
            await tx.showArtist.createMany({
              data: uniqueArtistIds.map((artistId) => ({
                showId: festival.id,
                artistId,
                headliner: false,
              })),
            });
          }
          return festival.id;
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        }
      );
    } catch (error) {
      if (error instanceof AmbiguousLineupError) throw error;
      const code =
        error instanceof Prisma.PrismaClientKnownRequestError
          ? error.code
          : null;
      if (code === "P2034" && attempt < 3) continue;
      throw error;
    }
  }
  throw new Error("Unable to persist festival");
}

export async function createFestival(
  previousState: FestivalFormState,
  formData: FormData
): Promise<FestivalFormState> {
  await requireServerActionAuth(
    formData.get("returnTo") ?? "/festivals/new"
  );
  const returnTo = workflowReturnPath(formData.get("returnTo"));
  void previousState;
  const values = readValues(formData);
  const validation = validateFestivalCreation(values);
  if (!validation.ok) {
    return errorState(values, validation.message);
  }
  const selections = new Map(
    validation.entries.map((entry) => [
      entry.selectionKey,
      formValue(formData, entry.selectionKey),
    ])
  );

  let festivalId: string;
  try {
    festivalId = await persistFestival(
      values,
      validation.date,
      validation.countryCode,
      validation.countryName,
      validation.festivalNycStatus,
      validation.entries,
      selections
    );
  } catch (error) {
    if (error instanceof AmbiguousLineupError) {
      return errorState(
        values,
        "Multiple artists share these normalized names. Choose the intended existing artist for each lineup entry, then submit again.",
        error.ambiguities
      );
    }
    console.error("Unable to create festival transaction", error);
    return errorState(
      values,
      "Unable to create the festival. No changes were saved; please try again."
    );
  }

  const returnUrl = new URL(returnTo, "https://festivals.local");
  redirect(
    festivalReturnPath(
      festivalId,
      "all",
      "all",
      parseFestivalListView({
        includeInternational: returnUrl.searchParams.get(
          "includeInternational"
        ),
        dismissed: returnUrl.searchParams.get("dismissed"),
      })
    )
  );
}
