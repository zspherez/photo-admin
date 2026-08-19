import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { acquireArtistIdentityLock } from "@/lib/artistIdentity";
import { acquireShowArtistMembershipLock } from "@/lib/showArtistMembershipInvariant";
import { normalizeEmail } from "@/lib/resend";

const ACTIVE_OUTREACH_STATUSES = ["queued"] as const;
const ACTIVE_RESEARCH_STATUSES = ["claimed"] as const;
const ACTIVE_AUDIT_STATUSES = ["claimed"] as const;

type ArtistMergeRecord = Awaited<ReturnType<typeof loadArtistMergeRecord>>;
type ArtistMergeClient = Prisma.TransactionClient | typeof db;
export type ArtistMergeArtist = NonNullable<ArtistMergeRecord>;

export interface ArtistMergePreview {
  source: ArtistMergeArtist;
  target: ArtistMergeArtist;
  blockers: string[];
  moveCounts: {
    contacts: number;
    shows: number;
    listenSignals: number;
    playlists: number;
    outreaches: number;
    researchRecords: number;
    auditRecords: number;
    trajectoryRecords: number;
  };
}

export interface ArtistMergeResult {
  mergeEventId: string;
  sourceArtistId: string;
  targetArtistId: string;
  moved: ArtistMergePreview["moveCounts"];
}

async function loadArtistMergeRecord(
  artistId: string,
  client: ArtistMergeClient = db,
) {
  return client.artist.findUnique({
    where: { id: artistId },
    select: {
      id: true,
      name: true,
      customName: true,
      normalizedName: true,
      spotifyId: true,
      statsfmId: true,
      edmtrainId: true,
      genres: true,
      popularity: true,
      imageUrl: true,
      contacts: {
        select: { id: true, email: true, state: true },
        orderBy: { id: "asc" },
      },
      contactResearchJob: {
        select: { id: true, status: true },
      },
      contactAuditDecisions: {
        select: { id: true, runId: true },
      },
      contactAuditJobs: {
        where: { status: { in: [...ACTIVE_AUDIT_STATUSES] } },
        select: { id: true },
      },
      outreaches: {
        where: { status: { in: [...ACTIVE_OUTREACH_STATUSES] } },
        select: { id: true },
      },
      trajectoryRuns: {
        select: { id: true },
      },
      _count: {
        select: {
          contacts: true,
          shows: true,
          listenSignals: true,
          playlists: true,
          outreaches: true,
          outreachCoverages: true,
          researchSkips: true,
          contactAuditRequests: true,
          contactAuditJobs: true,
          contactAuditDecisions: true,
          trajectoryRuns: true,
        },
      },
    },
  });
}

function contactEmailSet(
  contacts: readonly { email: string | null }[],
): Set<string> {
  return new Set(
    contacts.flatMap((contact) => {
      const email = normalizeEmail(contact.email ?? "");
      return email ? [email] : [];
    }),
  );
}

function externalIdentities(artist: {
  spotifyId: string | null;
  statsfmId: string | null;
  edmtrainId: number | null;
}): Array<{ provider: string; externalId: string }> {
  return [
    ...(artist.spotifyId
      ? [{ provider: "spotify", externalId: artist.spotifyId }]
      : []),
    ...(artist.statsfmId
      ? [{ provider: "statsfm", externalId: artist.statsfmId }]
      : []),
    ...(artist.edmtrainId != null
      ? [{ provider: "edmtrain", externalId: String(artist.edmtrainId) }]
      : []),
  ];
}

async function previewBlockers(
  source: NonNullable<ArtistMergeRecord>,
  target: NonNullable<ArtistMergeRecord>,
  client: ArtistMergeClient = db,
): Promise<string[]> {
  const blockers: string[] = [];
  if (!source.normalizedName || source.normalizedName !== target.normalizedName) {
    blockers.push("Artists must share the same non-empty normalized name.");
  }
  const targetEmails = contactEmailSet(target.contacts);
  const duplicateEmails = source.contacts.flatMap((contact) => {
    const email = normalizeEmail(contact.email ?? "");
    return email && targetEmails.has(email) ? [email] : [];
  });
  if (duplicateEmails.length > 0) {
    blockers.push(
      `Both records contain the same contact email: ${[
        ...new Set(duplicateEmails),
      ].join(", ")}. Resolve the contact duplicate first.`,
    );
  }
  if (source.contactResearchJob && target.contactResearchJob) {
    blockers.push(
      "Both artists have manager-research jobs. Resolve or deactivate one job first.",
    );
  }
  const targetDecisionRuns = new Set(
    target.contactAuditDecisions.map((decision) => decision.runId),
  );
  if (
    source.contactAuditDecisions.some((decision) =>
      targetDecisionRuns.has(decision.runId),
    )
  ) {
    blockers.push(
      "Both artists have a decision in the same contact-audit run.",
    );
  }
  if (source.outreaches.length > 0 || target.outreaches.length > 0) {
    blockers.push("An outreach send is currently in progress.");
  }
  if (
    source.contactResearchJob?.status &&
    ACTIVE_RESEARCH_STATUSES.includes(
      source.contactResearchJob.status as (typeof ACTIVE_RESEARCH_STATUSES)[number],
    )
  ) {
    blockers.push("The duplicate artist has an active manager-research claim.");
  }
  if (
    target.contactResearchJob?.status &&
    ACTIVE_RESEARCH_STATUSES.includes(
      target.contactResearchJob.status as (typeof ACTIVE_RESEARCH_STATUSES)[number],
    )
  ) {
    blockers.push("The canonical artist has an active manager-research claim.");
  }
  if (
    source.contactAuditJobs.length > 0 ||
    target.contactAuditJobs.length > 0
  ) {
    blockers.push("A contact-audit job is currently claimed for this artist.");
  }
  const identities = externalIdentities(source);
  const aliases =
    identities.length === 0
      ? []
      : await client.artistExternalIdentityAlias.findMany({
          where: {
            OR: identities.map((identity) => ({
              provider: identity.provider,
              externalId: identity.externalId,
            })),
          },
          select: { artistId: true, provider: true, externalId: true },
        });
  const foreignAlias = aliases.find(
    (alias) =>
      alias.artistId !== source.id && alias.artistId !== target.id,
  );
  if (foreignAlias) {
    blockers.push(
      `${foreignAlias.provider} identity ${foreignAlias.externalId} is already aliased to another artist.`,
    );
  }
  return blockers;
}

function moveCounts(source: NonNullable<ArtistMergeRecord>) {
  return {
    contacts: source._count.contacts,
    shows: source._count.shows,
    listenSignals: source._count.listenSignals,
    playlists: source._count.playlists,
    outreaches: source._count.outreaches + source._count.outreachCoverages,
    researchRecords:
      (source.contactResearchJob ? 1 : 0) + source._count.researchSkips,
    auditRecords:
      source._count.contactAuditRequests +
      source._count.contactAuditJobs +
      source._count.contactAuditDecisions,
    trajectoryRecords: source._count.trajectoryRuns,
  };
}

export async function getArtistMergePreview(
  sourceArtistId: string,
  targetArtistId: string,
): Promise<ArtistMergePreview | null> {
  if (!sourceArtistId || !targetArtistId || sourceArtistId === targetArtistId) {
    return null;
  }
  const [source, target] = await Promise.all([
    loadArtistMergeRecord(sourceArtistId),
    loadArtistMergeRecord(targetArtistId),
  ]);
  if (!source || !target) return null;
  return {
    source,
    target,
    blockers: await previewBlockers(source, target),
    moveCounts: moveCounts(source),
  };
}

function fresherSignal<
  T extends { lastSeenAt: Date | null; fetchedAt: Date },
>(left: T, right: T): T {
  const leftTime = (left.lastSeenAt ?? left.fetchedAt).getTime();
  const rightTime = (right.lastSeenAt ?? right.fetchedAt).getTime();
  return rightTime > leftTime ? right : left;
}

async function mergeShowMemberships(
  tx: Prisma.TransactionClient,
  sourceArtistId: string,
  targetArtistId: string,
) {
  const sourceRows = await tx.showArtist.findMany({
    where: { artistId: sourceArtistId },
  });
  for (const source of sourceRows) {
    const target = await tx.showArtist.findUnique({
      where: {
        showId_artistId: {
          showId: source.showId,
          artistId: targetArtistId,
        },
      },
    });
    if (!target) {
      await tx.showArtist.update({
        where: {
          showId_artistId: {
            showId: source.showId,
            artistId: sourceArtistId,
          },
        },
        data: { artistId: targetArtistId },
      });
      continue;
    }
    await tx.showArtist.update({
      where: {
        showId_artistId: {
          showId: target.showId,
          artistId: targetArtistId,
        },
      },
      data: {
        headliner: target.headliner || source.headliner,
        providerManaged: target.providerManaged || source.providerManaged,
        manuallyAdded: target.manuallyAdded || source.manuallyAdded,
        rejectedAt:
          target.rejectedAt === null || source.rejectedAt === null
            ? null
            : new Date(
                Math.min(
                  target.rejectedAt.getTime(),
                  source.rejectedAt.getTime(),
                ),
              ),
      },
    });
    await tx.showArtist.delete({
      where: {
        showId_artistId: {
          showId: source.showId,
          artistId: sourceArtistId,
        },
      },
    });
  }
}

async function mergeListenSignals(
  tx: Prisma.TransactionClient,
  sourceArtistId: string,
  targetArtistId: string,
) {
  const sourceRows = await tx.listenSignal.findMany({
    where: { artistId: sourceArtistId },
  });
  for (const source of sourceRows) {
    const target = await tx.listenSignal.findUnique({
      where: {
        artistId_source: {
          artistId: targetArtistId,
          source: source.source,
        },
      },
    });
    if (!target) {
      await tx.listenSignal.update({
        where: { id: source.id },
        data: { artistId: targetArtistId },
      });
      continue;
    }
    const selected = fresherSignal(target, source);
    await tx.listenSignal.update({
      where: { id: target.id },
      data: {
        rank: selected.rank,
        playCount: selected.playCount,
        score: selected.score,
        lastSeenAt: selected.lastSeenAt,
        expiresAt: selected.expiresAt,
        syncGeneration: selected.syncGeneration,
        fetchedAt: selected.fetchedAt,
      },
    });
    await tx.listenSignal.delete({ where: { id: source.id } });
  }
}

async function mergeAliases(
  tx: Prisma.TransactionClient,
  source: NonNullable<ArtistMergeRecord>,
  target: NonNullable<ArtistMergeRecord>,
) {
  const targetPrimary = new Set(
    externalIdentities(target).map(
      (identity) => `${identity.provider}:${identity.externalId}`,
    ),
  );
  const aliases = [
    ...(await tx.artistExternalIdentityAlias.findMany({
      where: { artistId: source.id },
      select: {
        provider: true,
        externalId: true,
        sourceArtistId: true,
      },
    })),
    ...externalIdentities(source)
      .filter(
        (identity) =>
          !targetPrimary.has(`${identity.provider}:${identity.externalId}`),
      )
      .map((identity) => ({
        ...identity,
        sourceArtistId: source.id,
      })),
  ];
  for (const alias of aliases) {
    await tx.artistExternalIdentityAlias.upsert({
      where: {
        provider_externalId: {
          provider: alias.provider,
          externalId: alias.externalId,
        },
      },
      create: {
        artistId: target.id,
        provider: alias.provider,
        externalId: alias.externalId,
        sourceArtistId: alias.sourceArtistId,
      },
      update: { artistId: target.id },
    });
  }
}

async function mergeInTransaction(
  tx: Prisma.TransactionClient,
  sourceArtistId: string,
  targetArtistId: string,
): Promise<ArtistMergeResult> {
  await acquireArtistIdentityLock(tx);
  await acquireShowArtistMembershipLock(tx);
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "Artist"
    WHERE "id" IN (${sourceArtistId}, ${targetArtistId})
    ORDER BY "id"
    FOR UPDATE
  `);
  const source = await loadArtistMergeRecord(sourceArtistId, tx);
  const target = await loadArtistMergeRecord(targetArtistId, tx);
  if (!source || !target) throw new Error("Artist merge target no longer exists.");
  const blockers = await previewBlockers(source, target, tx);
  if (blockers.length > 0) throw new Error(blockers.join(" "));

  await tx.artist.update({
    where: { id: source.id },
    data: { spotifyId: null, statsfmId: null, edmtrainId: null },
  });
  const updatedTarget = await tx.artist.update({
    where: { id: target.id },
    data: {
      customName: target.customName ?? source.customName,
      spotifyId: target.spotifyId ?? source.spotifyId,
      statsfmId: target.statsfmId ?? source.statsfmId,
      edmtrainId: target.edmtrainId ?? source.edmtrainId,
      genres: target.genres ?? source.genres,
      popularity: target.popularity ?? source.popularity,
      imageUrl: target.imageUrl ?? source.imageUrl,
    },
  });
  await mergeAliases(tx, source, { ...target, ...updatedTarget });

  await mergeShowMemberships(tx, source.id, target.id);
  await mergeListenSignals(tx, source.id, target.id);
  const sourcePlaylists = await tx.artistPlaylist.findMany({
    where: { artistId: source.id },
    select: { playlistId: true },
  });
  if (sourcePlaylists.length > 0) {
    await tx.artistPlaylist.createMany({
      data: sourcePlaylists.map((row) => ({
        artistId: target.id,
        playlistId: row.playlistId,
      })),
      skipDuplicates: true,
    });
  }
  await tx.artistPlaylist.deleteMany({ where: { artistId: source.id } });
  const sourceCoverages = await tx.outreachCoveredArtist.findMany({
    where: { artistId: source.id },
    select: { outreachId: true },
  });
  if (sourceCoverages.length > 0) {
    await tx.outreachCoveredArtist.createMany({
      data: sourceCoverages.map((row) => ({
        outreachId: row.outreachId,
        artistId: target.id,
      })),
      skipDuplicates: true,
    });
  }
  await tx.outreachCoveredArtist.deleteMany({
    where: { artistId: source.id },
  });

  await tx.contact.updateMany({
    where: { artistId: source.id },
    data: { artistId: target.id },
  });
  await tx.outreach.updateMany({
    where: { artistId: source.id },
    data: { artistId: target.id },
  });
  await tx.outreach.updateMany({
    where: { expectedRecipientArtistId: source.id },
    data: { expectedRecipientArtistId: target.id },
  });
  await tx.contactAuditRequest.updateMany({
    where: { artistId: source.id },
    data: { artistId: target.id },
  });
  await tx.contactAuditJob.updateMany({
    where: { artistId: source.id },
    data: { artistId: target.id },
  });
  await tx.contactAuditJob.updateMany({
    where: { resolvedArtistId: source.id },
    data: { resolvedArtistId: target.id },
  });
  await tx.contactAuditArtistDecision.updateMany({
    where: { artistId: source.id },
    data: { artistId: target.id },
  });
  await tx.artistResearchSkip.updateMany({
    where: { artistId: source.id },
    data: { artistId: target.id },
  });
  await tx.trajectoryRunArtist.updateMany({
    where: { artistId: source.id },
    data: { artistId: target.id },
  });
  if (source.contactResearchJob) {
    await tx.contactResearchJob.update({
      where: { id: source.contactResearchJob.id },
      data: { artistId: target.id },
    });
  }

  const moved = moveCounts(source);
  const mergeEventId = randomUUID();
  await tx.artistMergeEvent.create({
    data: {
      id: mergeEventId,
      sourceArtistId: source.id,
      sourceName: source.name,
      targetArtistId: target.id,
      targetName: target.name,
      sourceSnapshot: {
        name: source.name,
        customName: source.customName,
        normalizedName: source.normalizedName,
        spotifyId: source.spotifyId,
        statsfmId: source.statsfmId,
        edmtrainId: source.edmtrainId,
        genres: source.genres,
        popularity: source.popularity,
        imageUrl: source.imageUrl,
      },
      mergeSummary: moved,
    },
  });
  await tx.artist.delete({ where: { id: source.id } });
  return {
    mergeEventId,
    sourceArtistId: source.id,
    targetArtistId: target.id,
    moved,
  };
}

export async function mergeArtists(
  sourceArtistId: string,
  targetArtistId: string,
): Promise<ArtistMergeResult> {
  if (!sourceArtistId || !targetArtistId || sourceArtistId === targetArtistId) {
    throw new Error("Choose two different artists to merge.");
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await db.$transaction(
        (tx) => mergeInTransaction(tx, sourceArtistId, targetArtistId),
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          timeout: 30_000,
        },
      );
    } catch (error) {
      const retryable =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === "P2002" || error.code === "P2034");
      if (!retryable || attempt === 3) throw error;
    }
  }
  throw new Error("Artist merge did not complete.");
}
