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
  "gmail",
  "hotmail",
  "icloud",
  "outlook",
  "protonmail",
  "yahoo",
]);
const MIN_EVIDENCE_LENGTH = 40;

function normalizedText(value) {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}@._+-]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
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

function evidenceIdentifiers({ email, name, company }) {
  const identifiers = [];
  if (typeof email === "string" && email.trim()) {
    identifiers.push(email.trim().toLowerCase());
    const domain = email.split("@").at(-1)?.split(".")[0] ?? "";
    if (
      domain.length >= 4 &&
      !GENERIC_EMAIL_DOMAINS.has(domain.toLowerCase())
    ) {
      identifiers.push(normalizedText(domain));
    }
  }
  for (const value of [name, company]) {
    if (typeof value !== "string") continue;
    const normalized = normalizedText(value);
    if (normalized.length >= 3) identifiers.push(normalized);
  }
  return identifiers;
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
  const normalized = normalizedText(value);
  const compact = normalized.replace(/[^\p{L}\p{N}@._+-]+/gu, "");
  const identifiesCandidate = evidenceIdentifiers(identifiers).some(
    (identifier) =>
      normalized.includes(identifier) ||
      compact.includes(
        identifier.replace(/[^\p{L}\p{N}@._+-]+/gu, "")
      )
  );
  if (!identifiesCandidate) {
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
  assertNonSyntheticText(input.canonicalRule, `${field}.canonicalRule`);
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
      { email: candidate.email, name: candidate.name }
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
