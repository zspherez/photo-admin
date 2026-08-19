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
export type ArtistMergeResearchJobPolicy = "target" | "source";

export interface ArtistMergePreview {
  source: ArtistMergeArtist;
  target: ArtistMergeArtist;
  blockers: string[];
  researchJobConflict:
    | {
        source: NonNullable<ArtistMergeArtist["contactResearchJob"]>;
        target: NonNullable<ArtistMergeArtist["contactResearchJob"]>;
      }
    | null;
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

export interface ArtistMergeOptions {
  researchJobPolicy?: ArtistMergeResearchJobPolicy;
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
        select: {
          id: true,
          status: true,
          priority: true,
          nextShowAt: true,
          attemptCount: true,
          claimedAt: true,
          claimExpiresAt: true,
          claimToken: true,
          claimedAgentRules: true,
          claimedAgentRulesVersion: true,
          claimedDirectOutreachRules: true,
          userNotes: true,
          agentNotes: true,
          requestedShowId: true,
          completedAt: true,
          _count: {
            select: {
              candidates: true,
              directOutreachProposals: true,
            },
          },
        },
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
    researchJobConflict:
      source.contactResearchJob && target.contactResearchJob
        ? {
            source: source.contactResearchJob,
            target: target.contactResearchJob,
          }
        : null,
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

function combineNotes(
  preferred: string | null,
  secondary: string | null,
): string | null {
  const values = [preferred?.trim(), secondary?.trim()].filter(
    (value): value is string => Boolean(value),
  );
  return values.length === 0 ? null : [...new Set(values)].join("\n\n");
}

function earlierDate(
  left: Date | null,
  right: Date | null,
): Date | null {
  if (!left) return right;
  if (!right) return left;
  return left < right ? left : right;
}

function laterDate(
  left: Date | null,
  right: Date | null,
): Date | null {
  if (!left) return right;
  if (!right) return left;
  return left > right ? left : right;
}

async function mergeResearchCandidates(
  tx: Prisma.TransactionClient,
  winnerJobId: string,
  loserJobId: string,
) {
  const loserCandidates = await tx.contactResearchCandidate.findMany({
    where: { jobId: loserJobId },
    orderBy: { id: "asc" },
  });
  for (const loser of loserCandidates) {
    const winner = await tx.contactResearchCandidate.findUnique({
      where: {
        jobId_normalizedEmail: {
          jobId: winnerJobId,
          normalizedEmail: loser.normalizedEmail,
        },
      },
    });
    if (!winner) {
      await tx.contactResearchCandidate.update({
        where: { id: loser.id },
        data: { jobId: winnerJobId },
      });
      continue;
    }
    await tx.contactResearchCandidate.update({
      where: { id: winner.id },
      data: {
        sourceUrls: [...new Set([...winner.sourceUrls, ...loser.sourceUrls])],
        evidence:
          combineNotes(
            winner.evidence,
            `${loser.evidence}\n[Merged duplicate status: ${loser.status}]`,
          ) ?? winner.evidence,
        officialSourceType:
          winner.officialSourceType ?? loser.officialSourceType,
        officialSourceUrl: winner.officialSourceUrl ?? loser.officialSourceUrl,
        officialManagementLabel:
          winner.officialManagementLabel ?? loser.officialManagementLabel,
        officialSourceEvidence:
          combineNotes(
            winner.officialSourceEvidence,
            loser.officialSourceEvidence,
          ),
      },
    });
    await tx.contactResearchCandidate.delete({ where: { id: loser.id } });
  }
}

async function mergeResearchProposals(
  tx: Prisma.TransactionClient,
  winnerJobId: string,
  loserJobId: string,
) {
  const loserProposals =
    await tx.contactResearchDirectOutreachProposal.findMany({
      where: { jobId: loserJobId },
      orderBy: { id: "asc" },
    });
  for (const loser of loserProposals) {
    const winner =
      await tx.contactResearchDirectOutreachProposal.findUnique({
        where: {
          jobId_ruleId_normalizedManagerName: {
            jobId: winnerJobId,
            ruleId: loser.ruleId,
            normalizedManagerName: loser.normalizedManagerName,
          },
        },
      });
    if (!winner) {
      await tx.contactResearchDirectOutreachProposal.update({
        where: { id: loser.id },
        data: { jobId: winnerJobId },
      });
      continue;
    }
    await tx.contactResearchDirectOutreachProposal.update({
      where: { id: winner.id },
      data: {
        sourceUrls: [...new Set([...winner.sourceUrls, ...loser.sourceUrls])],
        evidenceQuotes: [
          ...new Set([...winner.evidenceQuotes, ...loser.evidenceQuotes]),
        ],
        note:
          combineNotes(
            winner.note,
            `${loser.note}\n[Merged duplicate status: ${loser.status}]`,
          ) ?? winner.note,
        managerCompany: winner.managerCompany ?? loser.managerCompany,
        contactId: winner.contactId ?? loser.contactId,
      },
    });
    await tx.contactResearchDirectOutreachProposal.delete({
      where: { id: loser.id },
    });
  }
}

async function mergeResearchJobs(
  tx: Prisma.TransactionClient,
  source: ArtistMergeArtist,
  target: ArtistMergeArtist,
  policy: ArtistMergeResearchJobPolicy | undefined,
) {
  const sourceJob = source.contactResearchJob;
  const targetJob = target.contactResearchJob;
  if (!sourceJob) return;
  if (!targetJob) {
    await tx.contactResearchJob.update({
      where: { id: sourceJob.id },
      data: { artistId: target.id },
    });
    return;
  }
  if (policy !== "source" && policy !== "target") {
    throw new Error("Choose which manager-research job to keep.");
  }
  const winner = policy === "source" ? sourceJob : targetJob;
  const loser = policy === "source" ? targetJob : sourceJob;

  await mergeResearchCandidates(tx, winner.id, loser.id);
  await mergeResearchProposals(tx, winner.id, loser.id);
  await tx.artistResearchSkip.updateMany({
    where: { sourceJobId: loser.id },
    data: { sourceJobId: winner.id },
  });
  await tx.contactResearchJob.delete({ where: { id: loser.id } });
  const [pendingCandidates, pendingProposals] = await Promise.all([
    tx.contactResearchCandidate.count({
      where: { jobId: winner.id, status: "pending" },
    }),
    tx.contactResearchDirectOutreachProposal.count({
      where: { jobId: winner.id, status: "pending" },
    }),
  ]);
  const mergedStatus =
    pendingCandidates > 0 || pendingProposals > 0
      ? "review"
      : winner.status;
  await tx.contactResearchJob.update({
    where: { id: winner.id },
    data: {
      artistId: target.id,
      status: mergedStatus,
      priority: Math.max(winner.priority, loser.priority),
      nextShowAt: earlierDate(winner.nextShowAt, loser.nextShowAt),
      attemptCount: Math.max(winner.attemptCount, loser.attemptCount),
      requestedShowId: winner.requestedShowId ?? loser.requestedShowId,
      claimedAgentRules:
        winner.claimedAgentRules ?? loser.claimedAgentRules,
      claimedAgentRulesVersion:
        winner.claimedAgentRulesVersion ?? loser.claimedAgentRulesVersion,
      userNotes: combineNotes(winner.userNotes, loser.userNotes),
      agentNotes: combineNotes(winner.agentNotes, loser.agentNotes),
      completedAt:
        mergedStatus === "review"
          ? null
          : laterDate(winner.completedAt, loser.completedAt),
      claimedAt: null,
      claimExpiresAt: null,
      claimToken: null,
    },
  });
}

async function mergeInTransaction(
  tx: Prisma.TransactionClient,
  sourceArtistId: string,
  targetArtistId: string,
  options: ArtistMergeOptions,
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
  if (
    source.contactResearchJob &&
    target.contactResearchJob &&
    !options.researchJobPolicy
  ) {
    throw new Error("Choose which manager-research job to keep.");
  }

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
  await mergeResearchJobs(
    tx,
    source,
    target,
    options.researchJobPolicy,
  );

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
  options: ArtistMergeOptions = {},
): Promise<ArtistMergeResult> {
  if (!sourceArtistId || !targetArtistId || sourceArtistId === targetArtistId) {
    throw new Error("Choose two different artists to merge.");
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await db.$transaction(
        (tx) =>
          mergeInTransaction(
            tx,
            sourceArtistId,
            targetArtistId,
            options,
          ),
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
