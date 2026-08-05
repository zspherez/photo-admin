"use server";

import { Prisma } from "@prisma/client";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireServerActionAuth } from "@/lib/auth";
import { acquireArtistIdentityLock } from "@/lib/artistIdentity";
import {
  acquireShowArtistMembershipLock,
  staleReadyTrajectoryRunsWithMissingMembership,
} from "@/lib/showArtistMembershipInvariant";
import { normalizeArtistName } from "@/lib/normalize";
import {
  chooseManualFestivalArtist,
  parseManualFestivalArtistList,
  manualFestivalArtistRemoval,
  type ManualFestivalArtistCandidate,
} from "@/lib/manualFestivalArtist";
import {
  appendWorkflowResult,
  workflowReturnPath,
} from "@/lib/dashboardReturnUrl";
import { refreshWorkflowViews } from "@/lib/workflowRefresh";
import type {
  BulkManualFestivalArtistFormState,
  ManualFestivalArtistFormState,
} from "./manual-lineup-state";

type AddResult =
  | { kind: "added" }
  | { kind: "already-on-lineup" }
  | {
      kind: "ambiguous";
      candidates: ManualFestivalArtistCandidate[];
    };

function textValue(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function errorState(
  artistName: string,
  message: string,
  ambiguities: ManualFestivalArtistCandidate[] = [],
): ManualFestivalArtistFormState {
  return { artistName, message, ambiguities };
}

async function addArtistToFestival(
  showId: string,
  artistName: string,
  selectedId: string | null,
): Promise<AddResult> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await db.$transaction(
        async (tx) => {
          await acquireArtistIdentityLock(tx);
          await acquireShowArtistMembershipLock(tx);

          const festival = await tx.show.findFirst({
            where: { id: showId, isFestival: true },
            select: { id: true },
          });
          if (!festival) throw new Error("Festival not found");

          const normalizedName = normalizeArtistName(artistName);
          const matches = await tx.artist.findMany({
            where: { normalizedName },
            orderBy: { id: "asc" },
            select: {
              id: true,
              name: true,
              spotifyId: true,
              statsfmId: true,
              edmtrainId: true,
              shows: {
                where: { showId },
                select: { artistId: true, manuallyAdded: true },
              },
            },
          });
          const candidates = matches.map((candidate) => ({
            id: candidate.id,
            name: candidate.name,
            spotifyId: candidate.spotifyId,
            statsfmId: candidate.statsfmId,
            edmtrainId: candidate.edmtrainId,
            onLineup: candidate.shows.length > 0,
            manuallyAdded: candidate.shows[0]?.manuallyAdded ?? false,
          }));
          const decision = chooseManualFestivalArtist(
            candidates,
            selectedId,
          );
          if (decision.kind === "ambiguous") {
            return {
              kind: "ambiguous",
              candidates: [...decision.candidates],
            };
          }
          if (decision.kind === "already-on-lineup") {
            if (!decision.candidate.manuallyAdded) {
              await tx.showArtist.update({
                where: {
                  showId_artistId: {
                    showId,
                    artistId: decision.candidate.id,
                  },
                },
                data: { manuallyAdded: true },
              });
              return { kind: "added" };
            }
            return { kind: "already-on-lineup" };
          }

          const artistId =
            decision.kind === "use"
              ? decision.candidate.id
              : (
                  await tx.artist.create({
                    data: { name: artistName, normalizedName },
                    select: { id: true },
                  })
                ).id;

          await tx.showArtist.create({
            data: {
              showId,
              artistId,
              headliner: false,
              providerManaged: false,
              manuallyAdded: true,
            },
          });
          return { kind: "added" };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      const code =
        error instanceof Prisma.PrismaClientKnownRequestError
          ? error.code
          : null;
      if (
        (code === "P2034" || code === "P2002" || code === "P2028") &&
        attempt < 3
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new Error("Unable to add festival artist");
}

export async function addManualFestivalArtist(
  previousState: ManualFestivalArtistFormState,
  formData: FormData,
): Promise<ManualFestivalArtistFormState> {
  await requireServerActionAuth(
    formData.get("returnTo") ?? "/festivals",
  );
  const returnTo = workflowReturnPath(formData.get("returnTo"));
  void previousState;

  const showId = textValue(formData, "showId");
  const artistName = textValue(formData, "artistName");
  const selectedId = textValue(formData, "artistChoice") || null;
  const normalizedName = normalizeArtistName(artistName);
  if (!showId) return errorState(artistName, "Festival is required.");
  if (!normalizedName) {
    return errorState(
      artistName,
      "Enter an artist name containing letters or numbers.",
    );
  }
  if (artistName.length > 300) {
    return errorState(artistName, "Artist name must be 300 characters or less.");
  }

  let result: AddResult;
  try {
    result = await addArtistToFestival(showId, artistName, selectedId);
  } catch (error) {
    console.error("Unable to add manual festival artist", error);
    return errorState(
      artistName,
      "Unable to add the artist. No changes were saved; please try again.",
    );
  }

  if (result.kind === "ambiguous") {
    return errorState(
      artistName,
      "Multiple artists share this normalized name. Choose the intended existing artist.",
      result.candidates,
    );
  }
  if (result.kind === "already-on-lineup") {
    return errorState(artistName, "That artist is already on this lineup.");
  }

  refreshWorkflowViews(returnTo, ["/festivals", "/artists", "/research"]);
  redirect(appendWorkflowResult(returnTo, { lineup_added: "1" }));
}

export async function addManualFestivalArtists(
  previousState: BulkManualFestivalArtistFormState,
  formData: FormData,
): Promise<BulkManualFestivalArtistFormState> {
  await requireServerActionAuth(
    formData.get("returnTo") ?? "/festivals",
  );
  const returnTo = workflowReturnPath(formData.get("returnTo"));
  void previousState;

  const showId = textValue(formData, "showId");
  const artistNames = String(formData.get("artistNames") ?? "");
  const parsed = parseManualFestivalArtistList(artistNames);
  const base = {
    artistNames,
    addedCount: 0,
    preservedCount: 0,
    existingCount: 0,
    duplicateCount: parsed.duplicateCount,
    ambiguousNames: [] as string[],
  };
  if (!showId) return { ...base, message: "Festival is required." };
  if (parsed.error) return { ...base, message: parsed.error };

  try {
    let result:
      | {
          addedCount: number;
          preservedCount: number;
          existingCount: number;
          ambiguousNames: string[];
        }
      | undefined;
    const transactionDeadline = Date.now() + 270_000;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const remainingMs = transactionDeadline - Date.now();
        if (remainingMs < 2_000) {
          throw new Error("Festival artist merge exceeded its time budget");
        }
        const timeout = Math.min(
          60_000,
          Math.max(1_000, Math.floor(remainingMs / 2)),
        );
        const maxWait = Math.min(
          180_000,
          Math.max(1_000, remainingMs - timeout - 1_000),
        );
        result = await db.$transaction(
          async (tx) => {
            await acquireArtistIdentityLock(tx);
            await acquireShowArtistMembershipLock(tx);
            const festival = await tx.show.findFirst({
              where: { id: showId, isFestival: true },
              select: { id: true },
            });
            if (!festival) throw new Error("Festival not found");

            const normalizedNames = parsed.artists.map(
              (artist) => artist.normalizedName,
            );
            const initialMatches = await tx.artist.findMany({
              where: { normalizedName: { in: normalizedNames } },
              select: { normalizedName: true },
            });
            const existingNormalizedNames = new Set(
              initialMatches.map((artist) => artist.normalizedName),
            );
            const missing = parsed.artists.filter(
              (artist) => !existingNormalizedNames.has(artist.normalizedName),
            );
            if (missing.length > 0) {
              await tx.artist.createMany({
                data: missing.map((artist) => ({
                  name: artist.name,
                  normalizedName: artist.normalizedName,
                })),
              });
            }

            const matches = await tx.artist.findMany({
              where: { normalizedName: { in: normalizedNames } },
              orderBy: { id: "asc" },
              select: {
                id: true,
                normalizedName: true,
                shows: {
                  where: { showId },
                  select: {
                    providerManaged: true,
                    manuallyAdded: true,
                  },
                },
              },
            });
            const matchesByNormalizedName = new Map<
              string,
              typeof matches
            >();
            for (const match of matches) {
              const candidates =
                matchesByNormalizedName.get(match.normalizedName) ?? [];
              candidates.push(match);
              matchesByNormalizedName.set(match.normalizedName, candidates);
            }

            const preserveArtistIds: string[] = [];
            const createAssociations: Array<{
              showId: string;
              artistId: string;
              headliner: boolean;
              providerManaged: boolean;
              manuallyAdded: boolean;
            }> = [];
            let existingCount = 0;
            const ambiguousNames: string[] = [];
            for (const input of parsed.artists) {
              const candidates =
                matchesByNormalizedName.get(input.normalizedName) ?? [];
              const onLineup = candidates.filter(
                (candidate) => candidate.shows.length > 0,
              );
              if (candidates.length > 1 && onLineup.length !== 1) {
                ambiguousNames.push(input.name);
                continue;
              }

              const existingArtist =
                onLineup[0] ??
                (candidates.length === 1 ? candidates[0] : null);
              if (!existingArtist) {
                throw new Error(
                  `Canonical artist was not created for ${input.name}`,
                );
              }
              if (existingArtist?.shows[0]) {
                if (existingArtist.shows[0].manuallyAdded) {
                  existingCount += 1;
                } else {
                  preserveArtistIds.push(existingArtist.id);
                }
                continue;
              }
              createAssociations.push({
                showId,
                artistId: existingArtist.id,
                headliner: false,
                providerManaged: false,
                manuallyAdded: true,
              });
            }
            if (preserveArtistIds.length > 0) {
              await tx.showArtist.updateMany({
                where: {
                  showId,
                  artistId: { in: preserveArtistIds },
                  manuallyAdded: false,
                },
                data: { manuallyAdded: true },
              });
            }
            if (createAssociations.length > 0) {
              await tx.showArtist.createMany({
                data: createAssociations,
                skipDuplicates: true,
              });
            }
            return {
              addedCount: createAssociations.length,
              preservedCount: preserveArtistIds.length,
              existingCount,
              ambiguousNames,
            };
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            maxWait,
            timeout,
          },
        );
        break;
      } catch (error) {
        const code =
          error instanceof Prisma.PrismaClientKnownRequestError
            ? error.code
            : null;
        if (
          (code === "P2034" || code === "P2002" || code === "P2028") &&
          attempt < 3
        ) {
          continue;
        }
        throw error;
      }
    }
    if (!result) throw new Error("Unable to merge festival artist list");

    refreshWorkflowViews(returnTo, ["/festivals", "/artists", "/research"]);
    return {
      artistNames: result.ambiguousNames.join("\n"),
      message:
        result.ambiguousNames.length > 0
          ? "Added every unambiguous artist. Resolve the remaining names individually below."
          : "Festival lineup merged successfully.",
      duplicateCount: parsed.duplicateCount,
      ...result,
    };
  } catch (error) {
    console.error("Unable to add manual festival artist list", error);
    return {
      ...base,
      message:
        "Unable to merge the artist list. No changes were saved; please try again.",
    };
  }
}

export async function removeManualFestivalArtist(
  formData: FormData,
): Promise<void> {
  await requireServerActionAuth(
    formData.get("returnTo") ?? "/festivals",
  );
  const returnTo = workflowReturnPath(formData.get("returnTo"));
  const showId = textValue(formData, "showId");
  const artistId = textValue(formData, "artistId");
  if (!showId || !artistId) {
    redirect(
      appendWorkflowResult(returnTo, { lineup_error: "invalid_artist" }),
    );
  }

  let result: "deleted" | "provider-retained" | "provider-owned";
  try {
    result = await db.$transaction(
      async (tx) => {
        await acquireShowArtistMembershipLock(tx);
        const association = await tx.showArtist.findUnique({
          where: { showId_artistId: { showId, artistId } },
          select: {
            providerManaged: true,
            manuallyAdded: true,
            show: { select: { isFestival: true } },
          },
        });
        if (!association?.show.isFestival) {
          throw new Error("Festival artist not found");
        }

        const removal = manualFestivalArtistRemoval(association);
        if (removal === "provider-owned") return "provider-owned";
        if (removal === "retain-provider-association") {
          await tx.showArtist.update({
            where: { showId_artistId: { showId, artistId } },
            data: { manuallyAdded: false },
          });
          return "provider-retained";
        }
        await tx.showArtist.delete({
          where: { showId_artistId: { showId, artistId } },
        });
        await staleReadyTrajectoryRunsWithMissingMembership(tx);
        return "deleted";
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    console.error("Unable to remove manual festival artist", error);
    redirect(
      appendWorkflowResult(returnTo, { lineup_error: "remove_failed" }),
    );
  }

  refreshWorkflowViews(returnTo, ["/festivals", "/artists", "/research"]);
  redirect(
    appendWorkflowResult(
      returnTo,
      result === "provider-owned"
        ? { lineup_error: "provider_owned" }
        : result === "provider-retained"
          ? { lineup_manual_cleared: "1" }
          : { lineup_removed: "1" },
    ),
  );
}
