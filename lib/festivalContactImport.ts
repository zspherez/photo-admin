import { gunzipSync } from "node:zlib";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { normalizeArtistName } from "@/lib/normalize";
import { normalizeEmail } from "@/lib/resend";

const MAX_COMPRESSED_IMPORT_BYTES = 256 * 1024;
const MAX_UNCOMPRESSED_IMPORT_BYTES = 2 * 1024 * 1024;
const REQUIRED_HEADERS = [
  "festival",
  "festival_dates",
  "day",
  "name",
  "contact_email",
  "source",
  "source_url",
  "worked_with_before",
  "confidence",
  "notes",
  "status",
] as const;

export class FestivalContactImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FestivalContactImportError";
  }
}

export interface FestivalContactImportRow {
  festival: string;
  festivalDates: string;
  day: string;
  artistName: string;
  contactEmail: string;
  source: string;
  sourceUrl: string;
  workedWithBefore: string;
  confidence: string;
  notes: string;
  status: string;
}

export interface FestivalContactImportSummary {
  rows: number;
  rowsWithoutEmail: number;
  invalidEmails: number;
  unmatchedArtists: number;
  ambiguousArtists: number;
  intentionallySkippedArtists: number;
  exactActiveMatches: number;
  existingCandidates: number;
  createdCandidates: number;
  reviewJobs: number;
  dryRun: boolean;
}

interface ImportArtist {
  id: string;
  name: string;
  customName: string | null;
  normalizedName: string;
  activeSkip: boolean;
  contacts: Array<{
    email: string | null;
    state: "active" | "quarantined";
  }>;
  job: {
    id: string;
    status: string;
    candidates: Array<{ normalizedEmail: string; status: string }>;
  } | null;
}

interface PlannedCandidate {
  artistId: string;
  email: string;
  normalizedEmail: string;
  sourceUrls: string[];
  evidence: string;
  confidence: "high" | "medium" | "low";
}

interface FestivalContactImportPlan {
  candidates: PlannedCandidate[];
  reviewArtistIds: string[];
  summary: FestivalContactImportSummary;
}

function parseCsvMatrix(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (quoted) {
      if (character === '"') {
        if (csv[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) {
    throw new FestivalContactImportError(
      "CSV contains an unterminated quoted field",
    );
  }
  if (field || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows.filter((candidate) =>
    candidate.some((value) => value.trim().length > 0),
  );
}

export function parseFestivalContactCsv(csv: string): FestivalContactImportRow[] {
  const matrix = parseCsvMatrix(csv.replace(/^\uFEFF/, ""));
  const header = matrix[0]?.map((value) => value.trim()) ?? [];
  if (
    header.length !== REQUIRED_HEADERS.length ||
    REQUIRED_HEADERS.some((value, index) => header[index] !== value)
  ) {
    throw new FestivalContactImportError(
      `CSV headers must be exactly: ${REQUIRED_HEADERS.join(", ")}`,
    );
  }
  return matrix.slice(1).map((values, rowIndex) => {
    if (values.length !== header.length) {
      throw new FestivalContactImportError(
        `CSV row ${rowIndex + 2} has the wrong column count`,
      );
    }
    const record = Object.fromEntries(
      header.map((key, index) => [key, values[index]?.trim() ?? ""]),
    );
    return {
      festival: record.festival,
      festivalDates: record.festival_dates,
      day: record.day,
      artistName: record.name,
      contactEmail: record.contact_email,
      source: record.source,
      sourceUrl: record.source_url,
      workedWithBefore: record.worked_with_before,
      confidence: record.confidence,
      notes: record.notes,
      status: record.status,
    };
  });
}

export function decodeFestivalContactImportPayload(value: unknown): string {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as { gzipBase64?: unknown }).gzipBase64 !== "string"
  ) {
    throw new FestivalContactImportError("gzipBase64 is required");
  }
  const encoded = (value as { gzipBase64: string }).gzipBase64;
  if (
    !encoded ||
    encoded.length > MAX_COMPRESSED_IMPORT_BYTES * 2 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  ) {
    throw new FestivalContactImportError("gzipBase64 is invalid or too large");
  }
  const compressed = Buffer.from(encoded, "base64");
  if (compressed.length > MAX_COMPRESSED_IMPORT_BYTES) {
    throw new FestivalContactImportError("Compressed CSV is too large");
  }
  const uncompressed = gunzipSync(compressed, {
    maxOutputLength: MAX_UNCOMPRESSED_IMPORT_BYTES,
  });
  return uncompressed.toString("utf8");
}

function normalizedSourceUrl(value: string): string | null {
  if (!value || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.hostname
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function strongestConfidence(
  rows: readonly FestivalContactImportRow[],
): "high" | "medium" | "low" {
  if (rows.some((row) => row.confidence === "high")) return "high";
  if (rows.some((row) => row.confidence === "medium")) return "medium";
  return "low";
}

function csvRowIsIntentionalSkip(row: FestivalContactImportRow): boolean {
  const status = row.status.trim().toLowerCase().replace(/_/g, "-");
  return ["skip", "skipped", "intentional-skip"].includes(status);
}

function evidenceForRows(rows: readonly FestivalContactImportRow[]): string {
  return [
    "Imported from festival_contacts_master.csv for manual review.",
    ...rows.map((row) =>
      [
        `Festival: ${row.festival || "unspecified"}`,
        `Dates: ${row.festivalDates || "unspecified"}`,
        `Day: ${row.day || "unspecified"}`,
        `Source: ${row.source || "unspecified"}`,
        `Worked with before: ${row.workedWithBefore || "unspecified"}`,
        `Notes: ${row.notes || "none"}`,
      ].join(" | "),
    ),
  ]
    .join("\n")
    .slice(0, 8000);
}

export function planFestivalContactImport(
  rows: readonly FestivalContactImportRow[],
  artists: readonly ImportArtist[],
  dryRun: boolean,
): FestivalContactImportPlan {
  const artistsByName = new Map<string, ImportArtist[]>();
  for (const artist of artists) {
    const keys = new Set([
      artist.normalizedName,
      normalizeArtistName(artist.name),
      normalizeArtistName(artist.customName ?? ""),
    ]);
    for (const key of keys) {
      if (!key) continue;
      const values = artistsByName.get(key) ?? [];
      if (!values.some((candidate) => candidate.id === artist.id)) {
        values.push(artist);
      }
      artistsByName.set(key, values);
    }
  }

  const groupedRows = new Map<string, FestivalContactImportRow[]>();
  let rowsWithoutEmail = 0;
  let invalidEmails = 0;
  let unmatchedArtists = 0;
  let ambiguousArtists = 0;
  let intentionallySkippedArtists = 0;
  for (const row of rows) {
    if (csvRowIsIntentionalSkip(row)) {
      intentionallySkippedArtists += 1;
      continue;
    }
    if (!row.contactEmail) {
      rowsWithoutEmail += 1;
      continue;
    }
    const normalizedEmail = normalizeEmail(row.contactEmail);
    if (!normalizedEmail) {
      invalidEmails += 1;
      continue;
    }
    const normalizedArtist = normalizeArtistName(row.artistName);
    const matches = artistsByName.get(normalizedArtist) ?? [];
    if (matches.length === 0) {
      unmatchedArtists += 1;
      continue;
    }
    if (matches.length !== 1) {
      ambiguousArtists += 1;
      continue;
    }
    if (matches[0].activeSkip) {
      intentionallySkippedArtists += 1;
      continue;
    }
    const key = `${matches[0].id}\u0000${normalizedEmail}`;
    const values = groupedRows.get(key) ?? [];
    values.push(row);
    groupedRows.set(key, values);
  }

  let exactActiveMatches = 0;
  let existingCandidates = 0;
  const candidates: PlannedCandidate[] = [];
  const reviewArtistIds = new Set<string>();
  for (const [key, candidateRows] of groupedRows) {
    const [artistId, normalizedEmail] = key.split("\u0000");
    const artist = artists.find((value) => value.id === artistId)!;
    if (
      artist.contacts.some(
        (contact) =>
          contact.state === "active" &&
          normalizeEmail(contact.email ?? "") === normalizedEmail,
      )
    ) {
      exactActiveMatches += 1;
      continue;
    }
    const existing = artist.job?.candidates.find(
      (candidate) => candidate.normalizedEmail === normalizedEmail,
    );
    if (existing) {
      existingCandidates += 1;
      if (existing.status === "pending") reviewArtistIds.add(artistId);
      continue;
    }
    const sourceUrls = Array.from(
      new Set(
        candidateRows.flatMap((row) => {
          const url = normalizedSourceUrl(row.sourceUrl);
          return url ? [url] : [];
        }),
      ),
    );
    candidates.push({
      artistId,
      email: normalizedEmail,
      normalizedEmail,
      sourceUrls,
      evidence: evidenceForRows(candidateRows),
      confidence: strongestConfidence(candidateRows),
    });
    reviewArtistIds.add(artistId);
  }

  return {
    candidates,
    reviewArtistIds: [...reviewArtistIds],
    summary: {
      rows: rows.length,
      rowsWithoutEmail,
      invalidEmails,
      unmatchedArtists,
      ambiguousArtists,
      intentionallySkippedArtists,
      exactActiveMatches,
      existingCandidates,
      createdCandidates: candidates.length,
      reviewJobs: reviewArtistIds.size,
      dryRun,
    },
  };
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
      if (
        attempt === 3 ||
        !(
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2034"
        )
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
    }
  }
  throw new Error("Festival contact import retry loop exhausted");
}

export async function importFestivalContactsCsv(
  csv: string,
  dryRun: boolean,
): Promise<FestivalContactImportSummary> {
  const rows = parseFestivalContactCsv(csv);
  return withSerializableRetry(async (tx) => {
    const artists = await tx.artist.findMany({
      select: {
        id: true,
        name: true,
        customName: true,
        normalizedName: true,
        contacts: {
          select: { email: true, state: true },
        },
        researchSkips: {
          where: { clearedAt: null },
          take: 1,
          select: { id: true },
        },
        contactResearchJob: {
          select: {
            id: true,
            status: true,
            candidates: {
              select: { normalizedEmail: true, status: true },
            },
          },
        },
      },
    });
    const plan = planFestivalContactImport(
      rows,
      artists.map((artist) => ({
        ...artist,
        activeSkip: artist.researchSkips.length > 0,
        job: artist.contactResearchJob,
      })),
      dryRun,
    );
    if (dryRun) return plan.summary;

    const jobByArtist = new Map<string, string>();
    for (const artistId of plan.reviewArtistIds) {
      const job = await tx.contactResearchJob.upsert({
        where: { artistId },
        create: {
          artistId,
          status: "review",
          priority: 2000,
          completedAt: null,
        },
        update: {
          status: "review",
          completedAt: null,
          claimToken: null,
          claimedAt: null,
          claimExpiresAt: null,
        },
        select: { id: true },
      });
      jobByArtist.set(artistId, job.id);
    }
    for (const candidate of plan.candidates) {
      await tx.contactResearchCandidate.create({
        data: {
          jobId: jobByArtist.get(candidate.artistId)!,
          normalizedEmail: candidate.normalizedEmail,
          email: candidate.email,
          name: null,
          role: "management",
          sourceUrls: candidate.sourceUrls,
          evidence: candidate.evidence,
          confidence: candidate.confidence,
          needsApproval: true,
          officialSourceType: null,
          officialSourceUrl: null,
          officialManagementLabel: null,
          officialSourceEvidence: null,
          status: "pending",
        },
      });
    }
    return plan.summary;
  });
}
