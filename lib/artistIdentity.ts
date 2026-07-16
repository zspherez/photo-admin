import { randomUUID } from "node:crypto";
import { Prisma, type Artist } from "@prisma/client";
import { normalizeArtistName } from "@/lib/normalize";
import { chunkItems } from "@/lib/integrationUtils";

export interface ArtistIdentityInput {
  key: string;
  name: string;
  spotifyId?: string | null;
  statsfmId?: string | null;
  edmtrainId?: number | null;
  updateName?: boolean;
  genres?: string | null;
  popularity?: number | null;
  imageUrl?: string | null;
}

export type ArtistIdentityConflictKind =
  | "external-id-disagreement"
  | "normalized-name-conflict"
  | "ambiguous-name"
  | "empty-normalized-name";

export interface ArtistIdentityConflict {
  key: string;
  name: string;
  normalizedName: string;
  kind: ArtistIdentityConflictKind;
  candidateIds: string[];
}

type IdentityCandidate = Pick<
  Artist,
  "id" | "name" | "normalizedName" | "spotifyId" | "statsfmId" | "edmtrainId"
>;

export type ArtistIdentityDecision =
  | {
      action: "use";
      candidate: IdentityCandidate;
      conflicts: ArtistIdentityConflict[];
    }
  | {
      action: "create";
      conflicts: ArtistIdentityConflict[];
    }
  | {
      action: "unmatched";
      conflicts: ArtistIdentityConflict[];
    };

const externalFields = ["spotifyId", "statsfmId", "edmtrainId"] as const;

export const ARTIST_IDENTITY_LOCK_CLASS = 1_346_916_180;
export const ARTIST_IDENTITY_LOCK_KEY = 1_095_914_569;

export async function acquireArtistIdentityLock(
  tx: Prisma.TransactionClient
): Promise<void> {
  await tx.$queryRaw<Array<{ locked: number }>>(
    Prisma.sql`
      SELECT 1 AS "locked"
      FROM (
        SELECT pg_advisory_xact_lock(
          CAST(${ARTIST_IDENTITY_LOCK_CLASS} AS INTEGER),
          CAST(${ARTIST_IDENTITY_LOCK_KEY} AS INTEGER)
        )
      ) AS "artistIdentityLock"
    `
  );
}

function suppliedExternalIds(input: ArtistIdentityInput) {
  return externalFields.filter((field) => input[field] != null);
}

function matchesAnyExternalId(
  candidate: IdentityCandidate,
  input: ArtistIdentityInput
): boolean {
  return suppliedExternalIds(input).some((field) => candidate[field] === input[field]);
}

function hasExternalDisagreement(
  candidate: IdentityCandidate,
  input: ArtistIdentityInput
): boolean {
  return suppliedExternalIds(input).some(
    (field) => candidate[field] != null && candidate[field] !== input[field]
  );
}

function conflict(
  input: ArtistIdentityInput,
  normalizedName: string,
  kind: ArtistIdentityConflictKind,
  candidates: IdentityCandidate[]
): ArtistIdentityConflict {
  return {
    key: input.key,
    name: input.name,
    normalizedName,
    kind,
    candidateIds: Array.from(new Set(candidates.map((candidate) => candidate.id))),
  };
}

/**
 * External IDs select an artist authoritatively. A normalized name can bridge
 * providers only when it has exactly one compatible candidate; ambiguous names
 * are never resolved by ordering or popularity.
 */
export function chooseArtistIdentityCandidate(
  input: ArtistIdentityInput,
  candidates: readonly IdentityCandidate[]
): ArtistIdentityDecision {
  const normalizedName = normalizeArtistName(input.name);
  const externalIds = suppliedExternalIds(input);
  if (!normalizedName && externalIds.length === 0) {
    return {
      action: "unmatched",
      conflicts: [
        conflict(input, normalizedName, "empty-normalized-name", []),
      ],
    };
  }

  const externalMatches = candidates.filter((candidate) =>
    matchesAnyExternalId(candidate, input)
  );
  const externalMatchIds = new Set(externalMatches.map((candidate) => candidate.id));
  if (externalMatchIds.size > 1) {
    return {
      action: "unmatched",
      conflicts: [
        conflict(input, normalizedName, "external-id-disagreement", externalMatches),
      ],
    };
  }

  const externalMatch = externalMatches[0];
  if (externalMatch) {
    if (hasExternalDisagreement(externalMatch, input)) {
      return {
        action: "unmatched",
        conflicts: [
          conflict(input, normalizedName, "external-id-disagreement", [externalMatch]),
        ],
      };
    }
    const sameNameOthers = candidates.filter(
      (candidate) =>
        normalizedName &&
        candidate.id !== externalMatch.id &&
        candidate.normalizedName === normalizedName
    );
    return {
      action: "use",
      candidate: externalMatch,
      conflicts:
        sameNameOthers.length > 0
          ? [
              conflict(
                input,
                normalizedName,
                "normalized-name-conflict",
                sameNameOthers
              ),
            ]
          : [],
    };
  }

  const sameName = normalizedName
    ? candidates.filter(
        (candidate) => candidate.normalizedName === normalizedName
      )
    : [];
  if (sameName.length === 0) return { action: "create", conflicts: [] };

  if (sameName.length === 1 && !hasExternalDisagreement(sameName[0], input)) {
    return { action: "use", candidate: sameName[0], conflicts: [] };
  }

  const nameConflict = conflict(
    input,
    normalizedName,
    sameName.length > 1 ? "ambiguous-name" : "normalized-name-conflict",
    sameName
  );
  if (externalIds.length > 0) {
    return { action: "create", conflicts: [nameConflict] };
  }
  return { action: "unmatched", conflicts: [nameConflict] };
}

export class ArtistIdentityResolutionError extends Error {
  constructor(readonly conflicts: ArtistIdentityConflict[]) {
    super(
      `Artist identity is ambiguous: ${conflicts
        .map((item) => `${item.name} (${item.kind})`)
        .join(", ")}`
    );
    this.name = "ArtistIdentityResolutionError";
  }
}

export interface ResolvedArtists {
  artistsByKey: Map<string, Artist>;
  conflicts: ArtistIdentityConflict[];
  created: number;
}

type ArtistUpdatePatch = Partial<
  Pick<
    Artist,
    | "name"
    | "normalizedName"
    | "spotifyId"
    | "statsfmId"
    | "edmtrainId"
    | "genres"
    | "popularity"
    | "imageUrl"
  >
>;

function uniqueValues<T>(values: readonly T[]): T[] {
  return Array.from(new Set(values));
}

async function findLockedIdentityCandidates(
  tx: Prisma.TransactionClient,
  inputs: readonly ArtistIdentityInput[]
): Promise<Artist[]> {
  const spotifyIds = uniqueValues(
    inputs
      .map((input) => input.spotifyId)
      .filter((value): value is string => Boolean(value))
  );
  const statsfmIds = uniqueValues(
    inputs
      .map((input) => input.statsfmId)
      .filter((value): value is string => Boolean(value))
  );
  const edmtrainIds = uniqueValues(
    inputs
      .map((input) => input.edmtrainId)
      .filter((value): value is number => value != null)
  );
  const normalizedNames = uniqueValues(
    inputs.map((input) => normalizeArtistName(input.name)).filter(Boolean)
  );

  const predicates: Prisma.Sql[] = [];
  if (normalizedNames.length > 0) {
    predicates.push(
      Prisma.sql`"normalizedName" IN (${Prisma.join(
        normalizedNames
      )})`
    );
  }
  if (spotifyIds.length > 0) {
    predicates.push(
      Prisma.sql`"spotifyId" IN (${Prisma.join(spotifyIds)})`
    );
  }
  if (statsfmIds.length > 0) {
    predicates.push(
      Prisma.sql`"statsfmId" IN (${Prisma.join(statsfmIds)})`
    );
  }
  if (edmtrainIds.length > 0) {
    predicates.push(
      Prisma.sql`"edmtrainId" IN (${Prisma.join(edmtrainIds)})`
    );
  }
  if (predicates.length === 0) return [];

  return tx.$queryRaw<Artist[]>(
    Prisma.sql`
      SELECT
        "id",
        "name",
        "normalizedName",
        "spotifyId",
        "statsfmId",
        "edmtrainId",
        "genres",
        "popularity",
        "imageUrl",
        "createdAt",
        "updatedAt"
      FROM "Artist"
      WHERE ${Prisma.join(predicates, " OR ")}
      ORDER BY "id"
      FOR UPDATE
    `
  );
}

function artistUpdatePatch(
  input: ArtistIdentityInput,
  normalizedName: string,
  updateName: boolean
): ArtistUpdatePatch {
  return {
    ...(updateName ? { name: input.name, normalizedName } : {}),
    ...(input.spotifyId != null ? { spotifyId: input.spotifyId } : {}),
    ...(input.statsfmId != null ? { statsfmId: input.statsfmId } : {}),
    ...(input.edmtrainId != null ? { edmtrainId: input.edmtrainId } : {}),
    ...(input.genres !== undefined ? { genres: input.genres } : {}),
    ...(input.popularity !== undefined ? { popularity: input.popularity } : {}),
    ...(input.imageUrl !== undefined ? { imageUrl: input.imageUrl } : {}),
  };
}

function patchChangesArtist(
  artist: Artist,
  patch: ArtistUpdatePatch
): boolean {
  return Object.entries(patch).some(
    ([field, value]) => artist[field as keyof Artist] !== value
  );
}

export async function resolveArtists(
  tx: Prisma.TransactionClient,
  inputs: readonly ArtistIdentityInput[]
): Promise<ResolvedArtists> {
  const keys = new Set<string>();
  for (const input of inputs) {
    if (keys.has(input.key)) throw new Error(`Duplicate artist identity key: ${input.key}`);
    keys.add(input.key);
  }

  const invalidInputs = inputs.filter(
    (input) =>
      !normalizeArtistName(input.name) && suppliedExternalIds(input).length === 0
  );
  if (invalidInputs.length > 0) {
    throw new ArtistIdentityResolutionError(
      invalidInputs.map((input) =>
        conflict(input, "", "empty-normalized-name", [])
      )
    );
  }
  if (inputs.length === 0) {
    return { artistsByKey: new Map(), conflicts: [], created: 0 };
  }

  // This lock is shared by every provider reconciliation and by the
  // name-only Artist insert guard installed in the follow-up migration.
  await acquireArtistIdentityLock(tx);
  const candidates = await findLockedIdentityCandidates(tx, inputs);
  const artistIdByKey = new Map<string, string>();
  const conflicts: ArtistIdentityConflict[] = [];
  const createdById = new Map<string, Artist>();
  const updatesById = new Map<string, ArtistUpdatePatch>();
  const now = new Date();

  for (const input of inputs) {
    const decision = chooseArtistIdentityCandidate(input, candidates);
    conflicts.push(...decision.conflicts);
    if (decision.action === "unmatched") {
      throw new ArtistIdentityResolutionError(decision.conflicts);
    }

    const normalizedName = normalizeArtistName(input.name);
    const updateName = input.updateName !== false || decision.action === "create";
    const patch = artistUpdatePatch(input, normalizedName, updateName);

    let artist: Artist;
    if (decision.action === "use") {
      const existing = candidates.find(
        (candidate) => candidate.id === decision.candidate.id
      );
      if (!existing) {
        throw new Error(`Resolved artist disappeared: ${decision.candidate.id}`);
      }
      if (patchChangesArtist(existing, patch)) {
        artist = {
          ...existing,
          ...patch,
          updatedAt: now,
        };
        const index = candidates.findIndex(
          (candidate) => candidate.id === existing.id
        );
        candidates[index] = artist;
        if (createdById.has(existing.id)) {
          createdById.set(existing.id, artist);
        } else {
          updatesById.set(existing.id, {
            ...updatesById.get(existing.id),
            ...patch,
          });
        }
      } else {
        artist = existing;
      }
    } else {
      artist = {
        id: randomUUID(),
        name: input.name,
        normalizedName,
        spotifyId: input.spotifyId ?? null,
        statsfmId: input.statsfmId ?? null,
        edmtrainId: input.edmtrainId ?? null,
        genres: input.genres ?? null,
        popularity: input.popularity ?? null,
        imageUrl: input.imageUrl ?? null,
        createdAt: now,
        updatedAt: now,
      };
      createdById.set(artist.id, artist);
    }
    if (decision.action === "create") {
      candidates.push(artist);
    }
    artistIdByKey.set(input.key, artist.id);
  }

  for (const createChunk of chunkItems(Array.from(createdById.values()), 500)) {
    await tx.artist.createMany({
      data: createChunk.map((artist) => ({
        id: artist.id,
        name: artist.name,
        normalizedName: artist.normalizedName,
        spotifyId: artist.spotifyId,
        statsfmId: artist.statsfmId,
        edmtrainId: artist.edmtrainId,
        genres: artist.genres,
        popularity: artist.popularity,
        imageUrl: artist.imageUrl,
        createdAt: artist.createdAt,
        updatedAt: artist.updatedAt,
      })),
    });
  }

  const updatedById = new Map<string, Artist>();
  for (const updateChunk of chunkItems(
    Array.from(updatesById.entries()),
    100
  )) {
    const updated = await Promise.all(
      updateChunk.map(([id, data]) =>
        tx.artist.update({
          where: { id },
          data,
        })
      )
    );
    for (const artist of updated) updatedById.set(artist.id, artist);
  }

  const finalById = new Map(candidates.map((artist) => [artist.id, artist]));
  for (const artist of updatedById.values()) finalById.set(artist.id, artist);
  const artistsByKey = new Map<string, Artist>();
  for (const [key, artistId] of artistIdByKey) {
    const artist = finalById.get(artistId);
    if (!artist) throw new Error(`Resolved artist was not persisted: ${artistId}`);
    artistsByKey.set(key, artist);
  }

  return {
    artistsByKey,
    conflicts,
    created: createdById.size,
  };
}
