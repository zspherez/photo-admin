import { isIP } from "node:net";

const RESERVED_HOSTS = new Set([
  "example.com",
  "example.net",
  "example.org",
  "localhost",
]);
const RESERVED_SUFFIXES = [
  ".example",
  ".invalid",
  ".localhost",
  ".test",
];
const GENERIC_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "hotmail.com",
  "icloud.com",
  "outlook.com",
  "protonmail.com",
  "yahoo.com",
]);
const IDENTITY_STOPWORDS = new Set([
  "agency",
  "and",
  "artist",
  "booking",
  "company",
  "contact",
  "entertainment",
  "for",
  "group",
  "inc",
  "llc",
  "ltd",
  "management",
  "manager",
  "mgmt",
  "music",
  "name",
  "official",
  "of",
  "records",
  "team",
  "the",
  "unknown",
]);
const MIN_EVIDENCE_LENGTH = 40;

function normalizedIdentityText(value) {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .normalize("NFKC");
}

export function isObviousSyntheticPlaceholder(value) {
  if (typeof value !== "string") return false;
  const normalized = value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/^[\s"'`([{_-]+/, "");
  if (!normalized) return false;
  return (
    /^(?:dummy|placeholder|example|probe)\b/.test(normalized) ||
    /^save[\s_-]+test\b/.test(normalized) ||
    /^test\b(?![\s_-]+events?\b)/.test(normalized)
  );
}

export function assertNonSyntheticText(value, field) {
  if (typeof value !== "string" || !value.trim()) return;
  if (isObviousSyntheticPlaceholder(value)) {
    throw new Error(
      `${field} looks like a synthetic test or placeholder payload`
    );
  }
}

function isReservedHostname(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return (
    [...RESERVED_HOSTS].some(
      (reserved) => host === reserved || host.endsWith(`.${reserved}`)
    ) ||
    RESERVED_SUFFIXES.some(
      (suffix) => host === suffix.slice(1) || host.endsWith(suffix)
    )
  );
}

export function assertPublicHttpsSourceUrl(value, field) {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a URL string`);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} is invalid`);
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !hostname.includes(".") ||
    isIP(hostname) !== 0 ||
    isReservedHostname(hostname)
  ) {
    throw new Error(
      `${field} must be a real public HTTPS URL, not an example or test domain`
    );
  }
}

function identityTokens(value) {
  return normalizedIdentityText(value).match(/[\p{L}\p{N}]+/gu) ?? [];
}

function codePointLength(value) {
  return [...value].length;
}

function distinctiveIdentityTokens(value, kind) {
  const normalizedTokens = identityTokens(value);
  const originalTokens = value.match(/[\p{L}\p{N}]+/gu) ?? [];
  return normalizedTokens.filter((token, index) => {
    if (IDENTITY_STOPWORDS.has(token) || /^\p{N}+$/u.test(token)) {
      return false;
    }
    if (codePointLength(token) >= 4) return true;
    return (
      kind === "company" &&
      codePointLength(token) >= 3 &&
      originalTokens[index] === originalTokens[index]?.toUpperCase()
    );
  });
}

function containsDistinctiveTokens(evidenceTokens, identifierTokens) {
  if (identifierTokens.length === 0) return false;
  const evidenceTokenSet = new Set(evidenceTokens);
  return identifierTokens.every((identifier) =>
    evidenceTokenSet.has(identifier)
  );
}

function extractedEmails(value) {
  return (
    value
      .normalize("NFKC")
      .toLowerCase()
      .match(
        /[\p{L}\p{N}._%+-]+@(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?/gu
      ) ?? []
  );
}

function extractedDomains(value) {
  return (
    value
      .normalize("NFKC")
      .toLowerCase()
      .match(
        /(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?/gu
      ) ?? []
  );
}

function evidenceIdentifiesCandidate(evidence, { email, name, company }) {
  if (typeof email === "string" && email.trim()) {
    const normalizedEmail = email.normalize("NFKC").trim().toLowerCase();
    if (extractedEmails(evidence).includes(normalizedEmail)) return true;
    const domain = normalizedEmail.split("@").at(-1) ?? "";
    if (
      domain.includes(".") &&
      !GENERIC_EMAIL_DOMAINS.has(domain) &&
      extractedDomains(evidence).some(
        (candidate) =>
          candidate === domain || candidate.endsWith(`.${domain}`)
      )
    ) {
      return true;
    }
  }
  const evidenceTokens = identityTokens(evidence);
  for (const [kind, value] of [
    ["name", name],
    ["company", company],
  ]) {
    if (typeof value !== "string") continue;
    const tokens = distinctiveIdentityTokens(value, kind);
    if (containsDistinctiveTokens(evidenceTokens, tokens)) return true;
  }
  return false;
}

export function assertSubstantiveCandidateEvidence(
  value,
  field,
  identifiers,
  minimumLength = MIN_EVIDENCE_LENGTH
) {
  if (typeof value === "string") {
    assertNonSyntheticText(value, field);
  }
  if (typeof value !== "string" || value.trim().length < minimumLength) {
    throw new Error(
      `${field} must be substantive (${minimumLength} or more characters)`
    );
  }
  if (!evidenceIdentifiesCandidate(value, identifiers)) {
    throw new Error(
      `${field} must include the exact candidate email or clearly identify the submitted manager or company`
    );
  }
}

function validateSourceUrls(value, field) {
  if (!Array.isArray(value)) return;
  value.forEach((url, index) =>
    assertPublicHttpsSourceUrl(url, `${field}[${index}]`)
  );
}

function validateDirectOutreach(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const input = value;
  assertNonSyntheticText(
    input.instructionExcerpt,
    `${field}.instructionExcerpt`,
  );
  assertNonSyntheticText(input.note, `${field}.note`);
  if (!Array.isArray(input.evidence)) return;
  input.evidence.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    assertPublicHttpsSourceUrl(
      entry.sourceUrl,
      `${field}.evidence[${index}].sourceUrl`
    );
    assertNonSyntheticText(
      entry.quote,
      `${field}.evidence[${index}].quote`
    );
  });
}

function validateResearchCandidates(candidates, field) {
  if (!Array.isArray(candidates)) return;
  candidates.forEach((candidate, index) => {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      return;
    }
    const candidateField = `${field}[${index}]`;
    validateSourceUrls(candidate.sourceUrls, `${candidateField}.sourceUrls`);
    assertSubstantiveCandidateEvidence(
      candidate.evidence,
      `${candidateField}.evidence`,
      {
        email: candidate.email,
        name: candidate.name,
        company: candidate.company,
      }
    );
    if (
      candidate.officialSource &&
      typeof candidate.officialSource === "object" &&
      !Array.isArray(candidate.officialSource)
    ) {
      assertPublicHttpsSourceUrl(
        candidate.officialSource.url,
        `${candidateField}.officialSource.url`
      );
      assertNonSyntheticText(
        candidate.officialSource.evidence,
        `${candidateField}.officialSource.evidence`
      );
    }
  });
}

export function validateResearchBrokerPayload(action, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const input = value;
  assertNonSyntheticText(input.notes, "notes");
  if (action === "submit-exhausted") {
    if (typeof input.notes !== "string" || input.notes.trim().length < 30) {
      throw new Error(
        "exhausted notes must substantively describe the sources checked"
      );
    }
  }
  if (action === "submit-candidates") {
    validateResearchCandidates(input.candidates, "candidates");
    if (Array.isArray(input.reviewedEmails)) {
      input.reviewedEmails.forEach((reviewed, index) => {
        if (!reviewed || typeof reviewed !== "object") return;
        assertNonSyntheticText(
          reviewed.reason,
          `reviewedEmails[${index}].reason`
        );
      });
    }
  }
  validateDirectOutreach(input.directOutreach, "directOutreach");
}

export function validateResearchSubmissionPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const input = value;
  assertNonSyntheticText(input.notes, "notes");
  if (input.outcome === "exhausted") {
    if (typeof input.notes !== "string" || input.notes.trim().length < 30) {
      throw new Error(
        "exhausted notes must substantively describe the sources checked"
      );
    }
  }
  if (input.outcome === "candidates") {
    validateResearchCandidates(input.candidates, "candidates");
    validateDirectOutreach(input.directOutreach, "directOutreach");
  }
}

export function validateAuditSubmissionPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const input = value;
  validateSourceUrls(input.sourceUrls, "sourceUrls");
  if (typeof input.evidence === "string") {
    assertNonSyntheticText(input.evidence, "evidence");
    if (input.evidence.trim().length < MIN_EVIDENCE_LENGTH) {
      throw new Error(
        `evidence must be substantive (${MIN_EVIDENCE_LENGTH} or more characters)`
      );
    }
  }
  assertNonSyntheticText(input.notes, "notes");
  if (Array.isArray(input.rosterReview)) {
    input.rosterReview.forEach((review, index) => {
      if (!review || typeof review !== "object" || Array.isArray(review)) {
        return;
      }
      assertNonSyntheticText(
        review.notes,
        `rosterReview[${index}].notes`
      );
    });
  }
  if (!Array.isArray(input.alternatives)) return;
  input.alternatives.forEach((alternative, index) => {
    if (
      !alternative ||
      typeof alternative !== "object" ||
      Array.isArray(alternative)
    ) {
      return;
    }
    const field = `alternatives[${index}]`;
    validateSourceUrls(alternative.sourceUrls, `${field}.sourceUrls`);
    assertSubstantiveCandidateEvidence(
      alternative.evidence,
      `${field}.evidence`,
      { email: alternative.email, name: alternative.name }
    );
  });
}
