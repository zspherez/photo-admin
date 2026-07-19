import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
} from "jose";
import { db } from "@/lib/db";
import {
  addDateOnlyDays,
  easternDateOnly,
  easternTodayStoredDate,
  parseDateOnly,
} from "@/lib/calendarDate";
import { activeListenSignalWhere } from "@/lib/listenSignal";
import { appendContactToSheet, parseSheetEmails } from "@/lib/sheets";
import { constantTimeEqual } from "@/lib/auth";

export const CONTACT_RESEARCH_WINDOW_DAYS = 90;
export const CONTACT_RESEARCH_DEFAULT_CLAIM_LIMIT = 3;
export const CONTACT_RESEARCH_MAX_CLAIM_LIMIT = 10;
export const CONTACT_RESEARCH_CLAIM_TTL_MS = 60 * 60 * 1_000;
export const CONTACT_RESEARCH_OIDC_AUDIENCE =
  "photo-admin-contact-research";
export const CONTACT_RESEARCH_OIDC_ISSUER =
  "https://token.actions.githubusercontent.com";
export const CONTACT_RESEARCH_WORKFLOW_REF =
  "zspherez/photo-admin/.github/workflows/contact-research.yml@refs/heads/main";

const EMAIL_PATTERN = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const CONFIDENCE_VALUES = new Set(["high", "medium", "low"]);
const githubActionsJwks = createRemoteJWKSet(
  new URL(`${CONTACT_RESEARCH_OIDC_ISSUER}/.well-known/jwks`)
);

export interface ContactResearchCandidateInput {
  email: string;
  normalizedEmail: string;
  name: string | null;
  role: "management";
  sourceUrls: string[];
  evidence: string;
  confidence: "high" | "medium" | "low";
}

export type ContactResearchSubmission =
  | {
      outcome: "candidates";
      claimToken: string;
      notes: string | null;
      candidates: ContactResearchCandidateInput[];
    }
  | {
      outcome: "exhausted";
      claimToken: string;
      notes: string | null;
      candidates: [];
    };

export interface ContactResearchQueueResult {
  eligible: number;
  enqueued: number;
  reprioritized: number;
  completed: number;
  inactivated: number;
}

export interface ContactResearchPreparationResult
  extends ContactResearchQueueResult {
  claimable: number;
}

export interface ContactResearchPriorityInput {
  interested: boolean;
  hasActiveSignal: boolean;
  popularity: number | null;
  daysUntilShow: number;
}

const ACTIVE_EMAIL_CONTACT_WHERE = {
  state: "active",
  email: { not: null },
} satisfies Prisma.ContactWhereInput;

function optionalString(
  value: unknown,
  maxLength: number,
  field: string
): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) {
    throw new Error(`${field} must be at most ${maxLength} characters`);
  }
  return normalized;
}

function requiredString(
  value: unknown,
  maxLength: number,
  field: string
): string {
  const normalized = optionalString(value, maxLength, field);
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

export function normalizeResearchEmail(value: unknown): string {
  const raw = requiredString(value, 320, "email");
  const email = raw.toLowerCase();
  const parsed = parseSheetEmails(raw);
  if (
    parsed.isFullTeam ||
    parsed.emails.length !== 1 ||
    parsed.emails[0] !== email ||
    !EMAIL_PATTERN.test(email)
  ) {
    throw new Error("email is invalid");
  }
  return email;
}

export function isManagerContact(contact: {
  email: string | null;
  role: string | null;
  state?: "active" | "quarantined";
}): boolean {
  return Boolean(
    contact.email?.trim() && contact.state !== "quarantined"
  );
}

export function normalizeManagerRole(value: unknown): "management" {
  const role = requiredString(value, 100, "role").toLowerCase();
  if (role !== "manager" && role !== "management") {
    throw new Error("role must be manager or management");
  }
  return "management";
}

export function normalizeResearchSourceUrl(value: unknown): string {
  const raw = requiredString(value, 2_048, "source URL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("source URL is invalid");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password
  ) {
    throw new Error("source URL must be a public HTTP(S) URL");
  }
  url.hash = "";
  return url.toString();
}

export function parseContactResearchClaimLimit(value: unknown): number {
  if (value == null) return CONTACT_RESEARCH_DEFAULT_CLAIM_LIMIT;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > CONTACT_RESEARCH_MAX_CLAIM_LIMIT
  ) {
    throw new Error(
      `limit must be an integer from 1 to ${CONTACT_RESEARCH_MAX_CLAIM_LIMIT}`
    );
  }
  return value;
}

export function parseContactResearchSubmission(
  value: unknown
): ContactResearchSubmission {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("request body must be an object");
  }
  const input = value as Record<string, unknown>;
  const outcome = input.outcome;
  if (outcome !== "candidates" && outcome !== "exhausted") {
    throw new Error("outcome must be candidates or exhausted");
  }
  const claimToken = requiredString(input.claimToken, 200, "claimToken");
  const notes = optionalString(input.notes, 4_000, "notes");
  if (outcome === "exhausted") {
    return { outcome, claimToken, notes, candidates: [] };
  }
  if (!Array.isArray(input.candidates) || input.candidates.length === 0) {
    throw new Error("at least one candidate is required");
  }
  if (input.candidates.length > 10) {
    throw new Error("at most 10 candidates may be submitted");
  }

  const candidatesByEmail = new Map<string, ContactResearchCandidateInput>();
  for (const candidateValue of input.candidates) {
    if (
      typeof candidateValue !== "object" ||
      candidateValue === null ||
      Array.isArray(candidateValue)
    ) {
      throw new Error("each candidate must be an object");
    }
    const candidate = candidateValue as Record<string, unknown>;
    const normalizedEmail = normalizeResearchEmail(candidate.email);
    const sourceValues = candidate.sourceUrls;
    if (!Array.isArray(sourceValues) || sourceValues.length === 0) {
      throw new Error("each candidate needs at least one source URL");
    }
    if (sourceValues.length > 5) {
      throw new Error("each candidate may have at most 5 source URLs");
    }
    const sourceUrls = Array.from(
      new Set(sourceValues.map(normalizeResearchSourceUrl))
    );
    const confidence = requiredString(
      candidate.confidence,
      20,
      "confidence"
    );
    if (!CONFIDENCE_VALUES.has(confidence)) {
      throw new Error("confidence must be high, medium, or low");
    }
    candidatesByEmail.set(normalizedEmail, {
      email: normalizedEmail,
      normalizedEmail,
      name: optionalString(candidate.name, 200, "name"),
      role: normalizeManagerRole(candidate.role),
      sourceUrls,
      evidence: requiredString(candidate.evidence, 4_000, "evidence"),
      confidence: confidence as ContactResearchCandidateInput["confidence"],
    });
  }

  return {
    outcome,
    claimToken,
    notes,
    candidates: [...candidatesByEmail.values()],
  };
}

export async function isValidContactResearchAuthorization(
  authorization: string | null,
  secrets:
    | string
    | readonly (string | undefined)[]
    = [
      process.env.CONTACT_RESEARCH_AGENT_TOKEN,
      process.env.CRON_SECRET,
    ],
  verifyGithubActionsToken: (
    token: string
  ) => Promise<boolean> = verifyGithubActionsContactResearchToken
): Promise<boolean> {
  if (!authorization?.startsWith("Bearer ")) return false;
  const token = authorization.slice("Bearer ".length);
  if (!token) return false;
  const candidates = (Array.isArray(secrets) ? secrets : [secrets]).filter(
    (secret): secret is string => Boolean(secret)
  );
  const matches = await Promise.all(
    candidates.map((secret) => constantTimeEqual(token, secret))
  );
  return matches.some(Boolean) || verifyGithubActionsToken(token);
}

export function isTrustedContactResearchOidcClaims(
  payload: JWTPayload
): boolean {
  return (
    payload.repository === "zspherez/photo-admin" &&
    payload.repository_owner === "zspherez" &&
    payload.ref === "refs/heads/main" &&
    payload.workflow_ref === CONTACT_RESEARCH_WORKFLOW_REF &&
    (payload.event_name === "schedule" ||
      payload.event_name === "workflow_dispatch")
  );
}

export async function verifyGithubActionsContactResearchToken(
  token: string
): Promise<boolean> {
  if (token.split(".").length !== 3) return false;
  try {
    const { payload } = await jwtVerify(token, githubActionsJwks, {
      issuer: CONTACT_RESEARCH_OIDC_ISSUER,
      audience: CONTACT_RESEARCH_OIDC_AUDIENCE,
    });
    return isTrustedContactResearchOidcClaims(payload);
  } catch {
    return false;
  }
}

export function contactResearchPriority(
  input: ContactResearchPriorityInput
): number {
  const popularity = Math.max(0, Math.min(100, input.popularity ?? 0));
  const proximity = Math.max(
    0,
    CONTACT_RESEARCH_WINDOW_DAYS - Math.max(0, input.daysUntilShow)
  );
  return (
    (input.interested ? 1_000 : 0) +
    (input.hasActiveSignal ? 200 : 0) +
    popularity +
    proximity
  );
}

export async function refreshContactResearchQueue(
  now: Date = new Date()
): Promise<ContactResearchQueueResult> {
  const today = easternTodayStoredDate(now);
  const end = parseDateOnly(
    addDateOnlyDays(easternDateOnly(now), CONTACT_RESEARCH_WINDOW_DAYS)
  );
  const activeSignalWhere = activeListenSignalWhere(now);
  const rows = await db.showArtist.findMany({
    where: {
      show: {
        date: { gte: today, lte: end },
        isFestival: false,
        syncStatus: "active",
      },
      artist: {
        contacts: {
          none: ACTIVE_EMAIL_CONTACT_WHERE,
        },
      },
    },
    select: {
      artistId: true,
      show: {
        select: {
          date: true,
          interestedAt: true,
        },
      },
      artist: {
        select: {
          popularity: true,
          listenSignals: {
            where: activeSignalWhere,
            take: 1,
            select: { id: true },
          },
        },
      },
    },
  });
  const requestedRows = await db.contactResearchJob.findMany({
    where: {
      requestedShow: {
        date: { gte: today },
        syncStatus: "active",
      },
      artist: {
        contacts: { none: ACTIVE_EMAIL_CONTACT_WHERE },
      },
    },
    select: {
      artistId: true,
      priority: true,
      nextShowAt: true,
      requestedShow: {
        select: {
          date: true,
          artists: { select: { artistId: true } },
        },
      },
    },
  });

  const eligible = new Map<
    string,
    { priority: number; nextShowAt: Date }
  >();
  for (const row of rows) {
    const daysUntilShow = Math.max(
      0,
      Math.round((row.show.date.getTime() - today.getTime()) / 86_400_000)
    );
    const priority = contactResearchPriority({
      interested: row.show.interestedAt !== null,
      hasActiveSignal: row.artist.listenSignals.length > 0,
      popularity: row.artist.popularity,
      daysUntilShow,
    });
    const current = eligible.get(row.artistId);
    if (
      !current ||
      priority > current.priority ||
      row.show.date < current.nextShowAt
    ) {
      eligible.set(row.artistId, {
        priority: Math.max(priority, current?.priority ?? 0),
        nextShowAt:
          !current || row.show.date < current.nextShowAt
            ? row.show.date
            : current.nextShowAt,
      });
    }
  }
  for (const row of requestedRows) {
    if (!row.requestedShow) continue;
    if (
      !row.requestedShow.artists.some(
        (showArtist) => showArtist.artistId === row.artistId
      )
    ) {
      continue;
    }
    const current = eligible.get(row.artistId);
    eligible.set(row.artistId, {
      priority: Math.max(2_000, row.priority, current?.priority ?? 0),
      nextShowAt:
        current && current.nextShowAt < row.requestedShow.date
          ? current.nextShowAt
          : row.requestedShow.date,
    });
  }

  const artistIds = [...eligible.keys()];
  return withSerializableRetry(async (tx) => {
    const completed = await tx.contactResearchJob.updateMany({
      where: {
        status: { in: ["pending", "claimed", "review", "exhausted"] },
        artist: {
          contacts: {
            some: ACTIVE_EMAIL_CONTACT_WHERE,
          },
        },
      },
      data: {
        status: "complete",
        completedAt: now,
        claimToken: null,
        claimedAt: null,
        claimExpiresAt: null,
      },
    });
    const ineligibleWhere: Prisma.ContactResearchJobWhereInput = {
      status: { in: ["pending", "claimed", "review"] },
      artist: {
        contacts: {
          none: ACTIVE_EMAIL_CONTACT_WHERE,
        },
      },
      ...(artistIds.length > 0
        ? { artistId: { notIn: artistIds } }
        : {}),
    };
    const inactivated = await tx.contactResearchJob.updateMany({
      where: ineligibleWhere,
      data: {
        status: "inactive",
        claimToken: null,
        claimedAt: null,
        claimExpiresAt: null,
      },
    });
    if (artistIds.length === 0) {
      return {
        eligible: 0,
        enqueued: 0,
        reprioritized: 0,
        completed: completed.count,
        inactivated: inactivated.count,
      };
    }

    const existing = await tx.contactResearchJob.findMany({
      where: { artistId: { in: artistIds } },
      select: { artistId: true, status: true },
    });
    const existingByArtist = new Map(
      existing.map((job) => [job.artistId, job])
    );
    let created = 0;
    let reopened = 0;
    let reprioritized = 0;
    for (const artistId of artistIds) {
      const job = existingByArtist.get(artistId);
      if (!job) {
        created += 1;
        continue;
      }
      if (job.status === "complete" || job.status === "inactive") {
        reopened += 1;
        continue;
      }
      if (!["pending", "claimed", "review"].includes(job.status)) continue;
      reprioritized += 1;
    }

    const values = artistIds.map((artistId) => {
      const candidate = eligible.get(artistId)!;
      return Prisma.sql`(
        ${randomUUID()},
        ${artistId},
        'pending',
        ${candidate.priority},
        ${candidate.nextShowAt},
        ${now},
        ${now}
      )`;
    });
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "ContactResearchJob" AS job (
        "id",
        "artistId",
        "status",
        "priority",
        "nextShowAt",
        "createdAt",
        "updatedAt"
      )
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("artistId") DO UPDATE SET
        "status" = CASE
          WHEN job."status" IN ('complete', 'inactive') THEN 'pending'
          ELSE job."status"
        END,
        "priority" = EXCLUDED."priority",
        "nextShowAt" = EXCLUDED."nextShowAt",
        "completedAt" = CASE
          WHEN job."status" IN ('complete', 'inactive') THEN NULL
          ELSE job."completedAt"
        END,
        "updatedAt" = EXCLUDED."updatedAt"
    `);

    return {
      eligible: artistIds.length,
      enqueued: created + reopened,
      reprioritized,
      completed: completed.count,
      inactivated: inactivated.count,
    };
  }, { timeout: 30_000 });
}

export async function enqueueFestivalManagerResearch(
  showId: string,
  now: Date = new Date()
): Promise<{
  eligible: number;
  enqueued: number;
  alreadyQueued: number;
}> {
  const today = easternTodayStoredDate(now);
  const festival = await db.show.findFirst({
    where: {
      id: showId,
      isFestival: true,
      syncStatus: "active",
      date: { gte: today },
    },
    select: {
      id: true,
      date: true,
      artists: {
        where: {
          artist: {
            contacts: { none: ACTIVE_EMAIL_CONTACT_WHERE },
            listenSignals: { some: activeListenSignalWhere(now) },
          },
        },
        select: {
          artistId: true,
          artist: {
            select: {
              popularity: true,
              listenSignals: {
                where: activeListenSignalWhere(now),
                take: 1,
                select: { id: true },
              },
            },
          },
        },
      },
    },
  });
  if (!festival) throw new Error("Festival is inactive or unavailable");

  return withSerializableRetry(async (tx) => {
    const artistIds = festival.artists.map((row) => row.artistId);
    const existing =
      artistIds.length === 0
        ? []
        : await tx.contactResearchJob.findMany({
            where: { artistId: { in: artistIds } },
            select: { artistId: true, status: true },
          });
    const existingByArtist = new Map(
      existing.map((job) => [job.artistId, job.status])
    );
    let enqueued = 0;
    let alreadyQueued = 0;

    for (const row of festival.artists) {
      const priority =
        2_000 +
        contactResearchPriority({
          interested: true,
          hasActiveSignal: row.artist.listenSignals.length > 0,
          popularity: row.artist.popularity,
          daysUntilShow: Math.max(
            0,
            Math.round(
              (festival.date.getTime() - today.getTime()) / 86_400_000
            )
          ),
        });
      const status = existingByArtist.get(row.artistId);
      if (!status) {
        await tx.contactResearchJob.create({
          data: {
            artistId: row.artistId,
            requestedShowId: festival.id,
            priority,
            nextShowAt: festival.date,
          },
        });
        enqueued += 1;
        continue;
      }
      if (["complete", "exhausted", "inactive"].includes(status)) {
        await tx.contactResearchJob.update({
          where: { artistId: row.artistId },
          data: {
            requestedShowId: festival.id,
            status: "pending",
            priority,
            nextShowAt: festival.date,
            claimToken: null,
            claimedAt: null,
            claimExpiresAt: null,
            agentNotes: null,
            completedAt: null,
          },
        });
        enqueued += 1;
        continue;
      }
      await tx.contactResearchJob.update({
        where: { artistId: row.artistId },
        data: {
          requestedShowId: festival.id,
          priority,
          nextShowAt: festival.date,
        },
      });
      alreadyQueued += 1;
    }

    return {
      eligible: festival.artists.length,
      enqueued,
      alreadyQueued,
    };
  });
}

export async function prepareContactResearchQueue(
  now: Date = new Date()
): Promise<ContactResearchPreparationResult> {
  const refreshed = await refreshContactResearchQueue(now);
  const claimable = await db.contactResearchJob.count({
    where: {
      OR: [
        { status: "pending" },
        {
          status: "claimed",
          OR: [
            { claimExpiresAt: null },
            { claimExpiresAt: { lte: now } },
          ],
        },
      ],
    },
  });
  return { ...refreshed, claimable };
}

function parseGenres(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((genre): genre is string => typeof genre === "string")
      : [];
  } catch {
    return [];
  }
}

export async function claimContactResearchJobs(
  limit: number,
  now: Date = new Date()
) {
  const claimLimit = parseContactResearchClaimLimit(limit);
  const claimExpiresAt = new Date(now.getTime() + CONTACT_RESEARCH_CLAIM_TTL_MS);
  const today = easternTodayStoredDate(now);
  const end = parseDateOnly(
    addDateOnlyDays(easternDateOnly(now), CONTACT_RESEARCH_WINDOW_DAYS)
  );
  return db.$transaction(
    async (tx) => {
      const selected = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT job."id"
        FROM "ContactResearchJob" job
        WHERE (
          job."status" = 'pending'
          OR (
            job."status" = 'claimed'
            AND (
              job."claimExpiresAt" IS NULL
              OR job."claimExpiresAt" <= ${now}
            )
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "Contact" contact
          WHERE contact."artistId" = job."artistId"
            AND contact."state" = 'active'
            AND contact."email" IS NOT NULL
        )
        AND EXISTS (
          SELECT 1
          FROM "ShowArtist" show_artist
          JOIN "Show" show
            ON show."id" = show_artist."showId"
          WHERE show_artist."artistId" = job."artistId"
            AND show."date" >= ${today}
            AND show."syncStatus" = 'active'
            AND (
              (
                show."isFestival" = false
                AND show."date" <= ${end}
              )
              OR (
                job."requestedShowId" = show."id"
              )
            )
        )
        ORDER BY
          job."priority" DESC,
          job."nextShowAt" ASC NULLS LAST,
          job."createdAt" ASC
        LIMIT ${claimLimit}
        FOR UPDATE SKIP LOCKED
      `);
      const tokenById = new Map<string, string>();
      for (const row of selected) {
        const claimToken = randomUUID();
        tokenById.set(row.id, claimToken);
        await tx.contactResearchJob.update({
          where: { id: row.id },
          data: {
            status: "claimed",
            claimToken,
            claimedAt: now,
            claimExpiresAt,
            attemptCount: { increment: 1 },
          },
        });
      }
      if (selected.length === 0) return [];

      const jobs = await tx.contactResearchJob.findMany({
        where: { id: { in: selected.map((row) => row.id) } },
        include: {
          artist: {
            select: {
              id: true,
              name: true,
              spotifyId: true,
              edmtrainId: true,
              genres: true,
              popularity: true,
              contacts: {
                where: { state: "active" },
                select: {
                  email: true,
                  phone: true,
                  name: true,
                  role: true,
                },
              },
              shows: {
                where: {
                  show: {
                    date: { gte: easternTodayStoredDate(now) },
                    syncStatus: "active",
                  },
                },
                select: {
                  show: {
                    select: {
                      id: true,
                      date: true,
                      venueName: true,
                      city: true,
                      state: true,
                      ticketUrl: true,
                      interestedAt: true,
                      isFestival: true,
                    },
                  },
                },
              },
            },
          },
        },
      });
      const jobById = new Map(jobs.map((job) => [job.id, job]));
      return selected.flatMap((selectedJob) => {
        const job = jobById.get(selectedJob.id);
        if (!job) return [];
        const upcomingShows = job.artist.shows
          .map((row) => row.show)
          .sort((a, b) => a.date.getTime() - b.date.getTime())
          .slice(0, 8);
        return [
          {
            id: job.id,
            claimToken: tokenById.get(job.id)!,
            claimExpiresAt,
            attemptCount: job.attemptCount,
            priority: job.priority,
            artist: {
              id: job.artist.id,
              name: job.artist.name,
              spotifyId: job.artist.spotifyId,
              edmtrainId: job.artist.edmtrainId,
              genres: parseGenres(job.artist.genres),
              popularity: job.artist.popularity,
              existingContacts: job.artist.contacts,
              upcomingShows,
            },
          },
        ];
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
  );
}

export async function submitContactResearchResult(
  jobId: string,
  value: unknown,
  now: Date = new Date()
): Promise<{ accepted: boolean; status: "review" | "exhausted" | "conflict" }> {
  const submission = parseContactResearchSubmission(value);
  return withSerializableRetry(async (tx) => {
    const job = await tx.contactResearchJob.findFirst({
      where: {
        id: jobId,
        status: "claimed",
        claimToken: submission.claimToken,
        claimExpiresAt: { gt: now },
      },
      select: { id: true },
    });
    if (!job) return { accepted: false, status: "conflict" as const };

    if (submission.outcome === "exhausted") {
      await tx.contactResearchJob.update({
        where: { id: jobId },
        data: {
          status: "exhausted",
          agentNotes: submission.notes,
          claimToken: null,
          claimedAt: null,
          claimExpiresAt: null,
        },
      });
      return { accepted: true, status: "exhausted" as const };
    }

    for (const candidate of submission.candidates) {
      await tx.contactResearchCandidate.upsert({
        where: {
          jobId_normalizedEmail: {
            jobId,
            normalizedEmail: candidate.normalizedEmail,
          },
        },
        create: {
          jobId,
          ...candidate,
        },
        update: {
          email: candidate.email,
          name: candidate.name,
          role: "management",
          sourceUrls: candidate.sourceUrls,
          evidence: candidate.evidence,
          confidence: candidate.confidence,
          status: "pending",
          reviewedAt: null,
        },
      });
    }
    await tx.contactResearchJob.update({
      where: { id: jobId },
      data: {
        status: "review",
        agentNotes: submission.notes,
        claimToken: null,
        claimedAt: null,
        claimExpiresAt: null,
      },
    });
    return { accepted: true, status: "review" as const };
  });
}

async function withSerializableRetry<T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
  options: { timeout?: number } = {}
): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await db.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: options.timeout ?? 5_000,
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
  throw new Error("Unable to complete serializable transaction");
}

export async function approveContactResearchCandidate(
  candidateId: string,
  now: Date = new Date()
): Promise<{ ok: boolean; error?: string; sheetError?: string }> {
  const approved = await withSerializableRetry(async (tx) => {
    const candidate = await tx.contactResearchCandidate.findUnique({
      where: { id: candidateId },
      include: {
        job: {
          include: {
            artist: { select: { id: true, name: true } },
          },
        },
      },
    });
    if (
      !candidate ||
      candidate.status !== "pending" ||
      candidate.job.status !== "review"
    ) {
      return { ok: false as const, error: "Candidate is no longer reviewable" };
    }

    const existing = await tx.contact.findUnique({
      where: {
        artistId_email: {
          artistId: candidate.job.artistId,
          email: candidate.normalizedEmail,
        },
      },
    });
    const contact = existing
      ? await tx.contact.update({
          where: { id: existing.id },
          data: {
            state: "active",
            name: existing.name ?? candidate.name,
            role: "management",
          },
        })
      : await tx.contact.create({
          data: {
            artistId: candidate.job.artistId,
            email: candidate.normalizedEmail,
            name: candidate.name,
            role: "management",
            source: "research",
            state: "active",
          },
        });

    await Promise.all([
      tx.contactResearchCandidate.update({
        where: { id: candidate.id },
        data: { status: "approved", reviewedAt: now },
      }),
      tx.contactResearchCandidate.updateMany({
        where: {
          jobId: candidate.jobId,
          id: { not: candidate.id },
          status: "pending",
        },
        data: { status: "rejected", reviewedAt: now },
      }),
      tx.contactResearchJob.update({
        where: { id: candidate.jobId },
        data: {
          status: "complete",
          completedAt: now,
          claimToken: null,
          claimedAt: null,
          claimExpiresAt: null,
        },
      }),
    ]);

    return {
      ok: true as const,
      contact,
      artistName: candidate.job.artist.name,
      candidate,
      shouldAppendToSheet: !existing,
    };
  });
  if (!approved.ok) return approved;
  if (!approved.shouldAppendToSheet) return { ok: true };

  try {
    const source = approved.candidate.sourceUrls.join(" ");
    const notes = `Research source: ${source}`.slice(0, 1_000);
    const appended = await appendContactToSheet({
      artistName: approved.artistName,
      email: approved.contact.email!,
      managerName: approved.contact.name,
      role: approved.contact.role,
      customPrice: approved.contact.customPrice,
      notes,
    });
    const updated = await db.contact.updateMany({
      where: {
        id: approved.contact.id,
        source: "research",
      },
      data: {
        source: "sheet",
        sourceKey: appended.sourceKey,
        sourceSyncedAt: now,
      },
    });
    if (updated.count !== 1) {
      console.error(
        JSON.stringify({
          event: "contact_research_sheet_ownership_pending",
          contactId: approved.contact.id,
          sourceKey: appended.sourceKey,
        })
      );
      return {
        ok: true,
        sheetError:
          "Contact approved, but Sheet ownership will need reconciliation.",
      };
    }
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({
        event: "contact_research_sheet_append_failed",
        contactId: approved.contact.id,
        error: message,
      })
    );
    return {
      ok: true,
      sheetError: `Contact approved, but Sheet append failed: ${message.slice(
        0,
        160
      )}`,
    };
  }
}

export async function rejectContactResearchCandidate(
  candidateId: string,
  now: Date = new Date()
): Promise<{ ok: boolean; exhausted: boolean }> {
  return withSerializableRetry(async (tx) => {
    const candidate = await tx.contactResearchCandidate.findFirst({
      where: {
        id: candidateId,
        status: "pending",
        job: { status: "review" },
      },
      select: { id: true, jobId: true },
    });
    if (!candidate) return { ok: false, exhausted: false };
    await tx.contactResearchCandidate.update({
      where: { id: candidate.id },
      data: { status: "rejected", reviewedAt: now },
    });
    const remaining = await tx.contactResearchCandidate.count({
      where: { jobId: candidate.jobId, status: "pending" },
    });
    if (remaining === 0) {
      await tx.contactResearchJob.update({
        where: { id: candidate.jobId },
        data: { status: "exhausted" },
      });
    }
    return { ok: true, exhausted: remaining === 0 };
  });
}

export async function retryContactResearchJob(
  jobId: string
): Promise<boolean> {
  const result = await db.contactResearchJob.updateMany({
    where: {
      id: jobId,
      status: { in: ["exhausted", "review"] },
      artist: {
        contacts: { none: ACTIVE_EMAIL_CONTACT_WHERE },
      },
    },
    data: {
      status: "pending",
      claimToken: null,
      claimedAt: null,
      claimExpiresAt: null,
      agentNotes: null,
      completedAt: null,
    },
  });
  return result.count === 1;
}
