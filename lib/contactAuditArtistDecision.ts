import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { acquireArtistIdentityLock } from "@/lib/artistIdentity";
import { contactAuditResolutionClaimStaleBefore } from "@/lib/contactAuditResolutionPolicy";

export const CONTACT_AUDIT_ARTIST_ACTIONS = [
  "append",
  "replace_selected",
  "deactivate_selected",
  "rejected",
] as const;

export type ContactAuditArtistAction =
  (typeof CONTACT_AUDIT_ARTIST_ACTIONS)[number];

export type ContactAuditArtistDecisionResult =
  | {
      ok: true;
      status: "resolved" | "already_resolved";
      action: ContactAuditArtistAction;
    }
  | { ok: false; error: string };

function normalizedIds(values: readonly string[]): string[] {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter(Boolean)),
  ).slice(0, 100);
}

function rosterEntryMatchesContact(
  entry: {
    snapshotEmail: string | null;
    snapshotPhone: string | null;
    snapshotDirectOutreachNote: string | null;
    snapshotName: string | null;
    snapshotRole: string | null;
    snapshotSource: string | null;
    snapshotNotes: string | null;
    snapshotIsFullTeam: boolean;
  },
  contact: {
    state: string;
    email: string | null;
    phone: string | null;
    directOutreachNote: string | null;
    name: string | null;
    role: string | null;
    source: string | null;
    notes: string | null;
    isFullTeam: boolean;
  },
): boolean {
  return (
    contact.state === "active" &&
    contact.email === entry.snapshotEmail &&
    contact.phone === entry.snapshotPhone &&
    contact.directOutreachNote === entry.snapshotDirectOutreachNote &&
    contact.name === entry.snapshotName &&
    contact.role === entry.snapshotRole &&
    contact.source === entry.snapshotSource &&
    contact.notes === entry.snapshotNotes &&
    contact.isFullTeam === entry.snapshotIsFullTeam
  );
}

async function withSerializableRetry<T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await db.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 30_000,
      });
    } catch (error) {
      const code =
        error instanceof Prisma.PrismaClientKnownRequestError
          ? error.code
          : null;
      if ((code === "P2002" || code === "P2034") && attempt < 3) continue;
      throw error;
    }
  }
  throw new Error("Unable to save the artist contact audit decision");
}

export type ContactAuditArtistTransactionRunner = <T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
) => Promise<T>;

export async function resolveContactAuditArtist(
  input: {
    runId: string;
    artistId: string;
    action: ContactAuditArtistAction;
    alternativeId?: string | null;
    selectedContactIds?: readonly string[];
  },
  now: Date = new Date(),
  runTransaction: ContactAuditArtistTransactionRunner = withSerializableRetry,
): Promise<ContactAuditArtistDecisionResult> {
  const runId = input.runId.trim();
  const artistId = input.artistId.trim();
  const alternativeId = input.alternativeId?.trim() || null;
  const selectedContactIds = normalizedIds(input.selectedContactIds ?? []);
  if (!runId || !artistId) {
    return { ok: false, error: "Missing artist audit context." };
  }
  if (!CONTACT_AUDIT_ARTIST_ACTIONS.includes(input.action)) {
    return { ok: false, error: "Invalid artist audit action." };
  }
  if (
    (input.action === "append" || input.action === "replace_selected") !==
    Boolean(alternativeId)
  ) {
    return {
      ok: false,
      error: "This action requires one proposed manager contact.",
    };
  }
  if (
    (input.action === "replace_selected" ||
      input.action === "deactivate_selected") !==
    (selectedContactIds.length > 0)
  ) {
    return {
      ok: false,
      error: "Select at least one existing contact for this action.",
    };
  }

  try {
    return await runTransaction(async (tx) => {
      await acquireArtistIdentityLock(tx);
      await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT artist."id"
        FROM "Artist" artist
        WHERE artist."id" = ${artistId}
        FOR UPDATE
      `);
      const existingDecision = await tx.contactAuditArtistDecision.findUnique({
        where: { runId_artistId: { runId, artistId } },
        select: { action: true },
      });
      if (existingDecision) {
        return {
          ok: true as const,
          status: "already_resolved" as const,
          action: existingDecision.action as ContactAuditArtistAction,
        };
      }
      const lockedJobs = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT job."id"
        FROM "ContactAuditJob" job
        WHERE job."runId" = ${runId}
          AND job."artistId" = ${artistId}
        ORDER BY job."id"
        FOR UPDATE
      `);
      if (lockedJobs.length === 0) {
        return {
          ok: false as const,
          error: "No contact audit exists for this artist.",
        };
      }
      const staleClaimBefore = contactAuditResolutionClaimStaleBefore(now);
      await tx.contactAuditJob.updateMany({
        where: {
          runId,
          artistId,
          resolution: null,
          resolutionClaimToken: { not: null },
          resolutionClaimedAt: { lte: staleClaimBefore },
        },
        data: {
          resolutionClaimToken: null,
          resolutionClaimedAt: null,
        },
      });
      const auditState = await tx.contactAuditJob.findMany({
        where: { runId, artistId },
        select: {
          status: true,
          resolution: true,
          resolutionClaimToken: true,
          resolutionClaimedAt: true,
        },
      });
      if (auditState.some((job) => job.status !== "complete")) {
        return {
          ok: false as const,
          error: "This artist audit is still running. Wait for every contact result.",
        };
      }
      if (auditState.some((job) => job.resolution !== null)) {
        return {
          ok: false as const,
          error: "A legacy per-contact decision already exists. Run a new artist audit.",
        };
      }
      if (
        auditState.some(
          (job) =>
            job.resolutionClaimToken !== null &&
            (!job.resolutionClaimedAt ||
              job.resolutionClaimedAt > staleClaimBefore),
        )
      ) {
        return {
          ok: false as const,
          error: "Another contact audit decision is in progress. Refresh and retry.",
        };
      }

      const jobs = await tx.contactAuditJob.findMany({
        where: {
          runId,
          artistId,
          status: "complete",
          finding: { in: ["changed", "stale", "ambiguous"] },
          resolution: null,
        },
        select: {
          id: true,
          snapshotArtistName: true,
          finding: true,
          targetRosterEntryId: true,
          alternatives: alternativeId
            ? {
                where: { id: alternativeId },
                select: {
                  id: true,
                  normalizedEmail: true,
                  name: true,
                },
              }
            : false,
        },
      });
      if (jobs.length === 0) {
        return {
          ok: false as const,
          error: "No unresolved flagged audit exists for this artist.",
        };
      }
      const alternative = alternativeId
        ? jobs.flatMap((job) => job.alternatives)[0] ?? null
        : null;
      if (alternativeId && !alternative) {
        return {
          ok: false as const,
          error: "The selected proposed contact does not belong to this artist audit.",
        };
      }

      const roster = await tx.contactAuditRosterSnapshot.findUnique({
        where: {
          runId_snapshotArtistId: {
            runId,
            snapshotArtistId: artistId,
          },
        },
        include: { entries: true },
      });
      if (!roster) {
        return {
          ok: false as const,
          error: "This legacy audit has no complete artist roster. Run a new audit.",
        };
      }
      const entryByContactId = new Map(
        roster.entries.map((entry) => [entry.snapshotContactId, entry]),
      );
      const entryById = new Map(
        roster.entries.map((entry) => [entry.id, entry]),
      );
      if (
        selectedContactIds.some(
          (contactId) => !entryByContactId.has(contactId),
        )
      ) {
        return {
          ok: false as const,
          error: "Every selected contact must belong to the immutable artist roster.",
        };
      }
      if (input.action === "deactivate_selected") {
        const staleContactIds = new Set(
          jobs.flatMap((job) => {
            if (job.finding !== "stale" || !job.targetRosterEntryId) return [];
            const entry = entryById.get(job.targetRosterEntryId);
            return entry ? [entry.snapshotContactId] : [];
          }),
        );
        if (
          selectedContactIds.some(
            (contactId) => !staleContactIds.has(contactId),
          )
        ) {
          return {
            ok: false as const,
            error: "Only contacts explicitly found stale may be deactivated without a replacement.",
          };
        }
      }

      const selectedContacts =
        selectedContactIds.length === 0
          ? []
          : await tx.contact.findMany({
              where: {
                id: { in: selectedContactIds },
                artistId,
                state: "active",
              },
            });
      if (selectedContacts.length !== selectedContactIds.length) {
        return {
          ok: false as const,
          error: "A selected contact is missing or no longer active. Run a new audit.",
        };
      }
      for (const contact of selectedContacts) {
        const entry = entryByContactId.get(contact.id)!;
        if (!rosterEntryMatchesContact(entry, contact)) {
          return {
            ok: false as const,
            error: "A selected contact changed after the audit. Run a new audit.",
          };
        }
      }

      if (alternative) {
        const duplicate = await tx.contact.findFirst({
          where: {
            artistId,
            email: {
              equals: alternative.normalizedEmail,
              mode: "insensitive",
            },
          },
          select: { id: true },
        });
        if (duplicate) {
          return {
            ok: false as const,
            error: "That email is already stored for this artist.",
          };
        }
      }

      let createdContactId: string | null = null;
      if (alternative) {
        const created = await tx.contact.create({
          data: {
            id: randomUUID(),
            artistId,
            email: alternative.normalizedEmail,
            name: alternative.name,
            role: "management",
            source: "audit",
            state: "active",
          },
          select: { id: true },
        });
        createdContactId = created.id;
      }
      if (selectedContactIds.length > 0) {
        const quarantined = await tx.contact.updateMany({
          where: {
            id: { in: selectedContactIds },
            artistId,
            state: "active",
          },
          data: { state: "quarantined" },
        });
        if (quarantined.count !== selectedContactIds.length) {
          throw new Error("Selected contacts changed during the audit decision");
        }
      }

      const decisionId = randomUUID();
      if (selectedContacts.length > 0) {
        await tx.contactAuditDecisionContact.createMany({
          data: selectedContacts.map((contact) => {
            const entry = entryByContactId.get(contact.id)!;
            return {
              decisionId,
              contactId: contact.id,
              action: "quarantined",
              snapshotEmail: entry.snapshotEmail,
              snapshotPhone: entry.snapshotPhone,
              snapshotDirectOutreachNote:
                entry.snapshotDirectOutreachNote,
              snapshotName: entry.snapshotName,
              snapshotRole: entry.snapshotRole,
              snapshotSource: entry.snapshotSource,
              snapshotNotes: entry.snapshotNotes,
              snapshotIsFullTeam: entry.snapshotIsFullTeam,
            };
          }),
        });
      }
      await tx.contactAuditArtistDecision.create({
        data: {
          id: decisionId,
          runId,
          artistId,
          snapshotArtistName: roster.snapshotArtistName,
          action: input.action,
          selectedAlternativeId: alternative?.id ?? null,
          createdContactId,
          resolvedAt: now,
        },
      });
      await tx.contactAuditJob.updateMany({
        where: { runId, artistId, status: "complete" },
        data: { reviewedAt: now },
      });
      return {
        ok: true as const,
        status: "resolved" as const,
        action: input.action,
      };
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return {
        ok: false,
        error: "That contact or artist audit decision was already saved.",
      };
    }
    console.error(
      JSON.stringify({
        event: "contact_audit_artist_resolution_failed",
        runId,
        artistId,
        action: input.action,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return {
      ok: false,
      error: "The artist audit decision could not be saved.",
    };
  }
}
