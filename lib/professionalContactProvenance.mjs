import { isIP } from "node:net";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const freemail = require("freemail");
const SUPPLEMENTAL_PUBLIC_EMAIL_DOMAINS = new Set([
  "pm.me",
  "proton.me",
  "protonmail.ch",
  "protonmail.com",
]);
const GENERIC_ALIAS_ROOTS = new Set([
  "accounts",
  "admin",
  "billing",
  "booking",
  "bookings",
  "careers",
  "ceo",
  "community",
  "contact",
  "contactus",
  "events",
  "executive",
  "founder",
  "founders",
  "general",
  "hello",
  "help",
  "hi",
  "inbox",
  "info",
  "inquiries",
  "inquiry",
  "jobs",
  "leadership",
  "legal",
  "mail",
  "management",
  "marketing",
  "media",
  "office",
  "partners",
  "partnerships",
  "press",
  "privacy",
  "pr",
  "sales",
  "sponsorship",
  "support",
  "team",
]);
const RESERVED_HOSTS = new Set([
  "example.com",
  "example.net",
  "example.org",
  "localhost",
]);
const EMAIL_PATTERN = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function domainParents(domain) {
  const labels = domain.toLowerCase().replace(/\.$/, "").split(".");
  return labels.map((_, index) => labels.slice(index).join("."));
}

export function isPublicEmailProviderDomain(domain) {
  return domainParents(domain).some(
    (candidate) =>
      freemail.isFree(candidate) ||
      freemail.isDisposable(candidate) ||
      SUPPLEMENTAL_PUBLIC_EMAIL_DOMAINS.has(candidate),
  );
}

export function isGenericProfessionalAlias(localPart) {
  const base = localPart.toLowerCase().split("+")[0];
  const tokens = base.split(/[^a-z0-9]+/).filter(Boolean);
  const compact = base.replace(/[^a-z0-9]/g, "");
  if (
    GENERIC_ALIAS_ROOTS.has(compact) ||
    (tokens[0] && GENERIC_ALIAS_ROOTS.has(tokens[0]))
  ) {
    return true;
  }
  for (const root of GENERIC_ALIAS_ROOTS) {
    if (
      new RegExp(
        `^${root}(?:\\d{1,4}|us|me|nyc|la|sf|uk|usa|global)?$`,
      ).test(compact)
    ) {
      return true;
    }
  }
  return false;
}

export function assertNamedBusinessEmail(value, field = "email") {
  if (typeof value !== "string" || value.length > 320) {
    throw new Error(`${field} must be a valid email`);
  }
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  if (!EMAIL_PATTERN.test(normalized)) {
    throw new Error(`${field} must be a valid email`);
  }
  const [localPart, domain] = normalized.split("@");
  if (isPublicEmailProviderDomain(domain)) {
    throw new Error(
      `${field} must use an organization business domain, not a public or disposable email provider`,
    );
  }
  if (isGenericProfessionalAlias(localPart)) {
    throw new Error(
      `${field} must be a named person's address, not a generic or role inbox`,
    );
  }
  return normalized;
}

export function canonicalPublicHttpsUrl(value, field = "source URL") {
  if (typeof value !== "string" || value.length > 1_000) {
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
    RESERVED_HOSTS.has(hostname) ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".example") ||
    hostname.endsWith(".invalid") ||
    hostname.endsWith(".test")
  ) {
    throw new Error(`${field} must be a real public HTTPS URL`);
  }
  url.hash = "";
  return url.toString();
}

export function normalizedIdentityTokens(value) {
  return (
    String(value)
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  ).filter((token) => token.length >= 2);
}

function asciiNameTokens(value) {
  return normalizedIdentityTokens(value)
    .map((token) => token.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
}

export function emailPatternMatches(personName, email) {
  const normalizedEmail = assertNamedBusinessEmail(email);
  const localPart = normalizedEmail.split("@")[0];
  const tokens = asciiNameTokens(personName);
  if (tokens.length < 2) return [];
  const first = tokens[0];
  const last = tokens.at(-1);
  const patterns = {
    first,
    last,
    "first.last": `${first}.${last}`,
    firstlast: `${first}${last}`,
    flast: `${first[0]}${last}`,
    "f.last": `${first[0]}.${last}`,
    firstl: `${first}${last[0]}`,
    "first_last": `${first}_${last}`,
    "first-last": `${first}-${last}`,
    "last.first": `${last}.${first}`,
    lastfirst: `${last}${first}`,
    lastf: `${last}${first[0]}`,
  };
  return Object.entries(patterns)
    .filter(([, candidate]) => candidate === localPart)
    .map(([name]) => name);
}

export function domainsAssociated(left, right) {
  const a = left.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  const b = right.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

function assertAllTokens(sourceTokens, values, field) {
  const required = values.flatMap(normalizedIdentityTokens);
  if (
    required.length === 0 ||
    required.some((token) => !sourceTokens.has(token))
  ) {
    throw new Error(`${field} is not supported by fetched source content`);
  }
}

function assertAnyTokens(sourceTokens, value, field) {
  const required = normalizedIdentityTokens(value);
  if (
    required.length === 0 ||
    !required.some((token) => sourceTokens.has(token))
  ) {
    throw new Error(`${field} is not supported by fetched source content`);
  }
}

function parsedProvenance(provenance, expectedToken) {
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) {
    throw new Error("broker provenance is required");
  }
  if (
    typeof provenance.claimProvenanceToken !== "string" ||
    !UUID_PATTERN.test(provenance.claimProvenanceToken) ||
    provenance.claimProvenanceToken !== expectedToken
  ) {
    throw new Error("broker provenance is not bound to the current claim");
  }
  if (
    !Array.isArray(provenance.searches) ||
    provenance.searches.length > 20 ||
    !Array.isArray(provenance.fetchedSources) ||
    provenance.fetchedSources.length < 1 ||
    provenance.fetchedSources.length > 12
  ) {
    throw new Error("broker provenance is malformed or unbounded");
  }
  const searches = provenance.searches.map((search, index) => {
    if (
      !search ||
      typeof search !== "object" ||
      Array.isArray(search) ||
      typeof search.query !== "string" ||
      !search.query.trim() ||
      search.query.length > 300 ||
      !Array.isArray(search.resultUrls) ||
      search.resultUrls.length > 10
    ) {
      throw new Error(`broker provenance searches[${index}] is invalid`);
    }
    return {
      query: search.query.trim(),
      resultUrls: search.resultUrls.map((url, urlIndex) =>
        canonicalPublicHttpsUrl(
          url,
          `broker provenance searches[${index}].resultUrls[${urlIndex}]`,
        ),
      ),
    };
  });
  const sourceByUrl = new Map();
  const fetchedSources = provenance.fetchedSources.map((source, index) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      throw new Error(`broker provenance fetchedSources[${index}] is invalid`);
    }
    const url = canonicalPublicHttpsUrl(
      source.url,
      `broker provenance fetchedSources[${index}].url`,
    );
    if (
      typeof source.contentSha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(source.contentSha256) ||
      !Array.isArray(source.observedEmails) ||
      source.observedEmails.length > 20 ||
      !Array.isArray(source.contentTokens) ||
      source.contentTokens.length > 500
    ) {
      throw new Error(`broker provenance fetchedSources[${index}] is invalid`);
    }
    const observedEmails = source.observedEmails.map((email) =>
      assertNamedBusinessEmail(
        email,
        `broker provenance fetchedSources[${index}].observedEmails`,
      ),
    );
    const contentTokens = source.contentTokens.map((token) => {
      if (
        typeof token !== "string" ||
        token.length < 2 ||
        token.length > 100 ||
        normalizedIdentityTokens(token).length !== 1
      ) {
        throw new Error(
          `broker provenance fetchedSources[${index}].contentTokens is invalid`,
        );
      }
      return token;
    });
    if (
      new Set(observedEmails).size !== observedEmails.length ||
      new Set(contentTokens).size !== contentTokens.length ||
      sourceByUrl.has(url)
    ) {
      throw new Error("broker provenance contains duplicate source facts");
    }
    const normalized = {
      url,
      contentSha256: source.contentSha256,
      observedEmails,
      contentTokens,
    };
    sourceByUrl.set(url, normalized);
    return normalized;
  });
  return { searches, fetchedSources, sourceByUrl };
}

export function validateProfessionalContactProvenance(
  submission,
  provenance,
  context,
) {
  const parsed = parsedProvenance(
    provenance,
    context.claimProvenanceToken,
  );
  if (submission.outcome === "exhausted") return parsed;

  const websiteHost = context.website
    ? new URL(canonicalPublicHttpsUrl(context.website, "request website")).hostname
    : null;
  for (const [index, candidate] of submission.candidates.entries()) {
    const field = `candidates[${index}]`;
    const normalizedEmail = assertNamedBusinessEmail(
      candidate.email,
      `${field}.email`,
    );
    const emailDomain = normalizedEmail.split("@")[1];
    const sourceUrls = candidate.sourceUrls.map((url, sourceIndex) =>
      canonicalPublicHttpsUrl(url, `${field}.sourceUrls[${sourceIndex}]`),
    );
    const sources = sourceUrls.map((url) => {
      const source = parsed.sourceByUrl.get(url);
      if (!source) {
        throw new Error(
          `${field}.sourceUrls must all be fetched through the claim-bound broker`,
        );
      }
      return source;
    });
    const combinedTokens = new Set(
      sources.flatMap((source) => source.contentTokens),
    );
    assertAllTokens(
      combinedTokens,
      [context.personName],
      `${field} person identity`,
    );
    assertAllTokens(
      combinedTokens,
      [context.organizationName],
      `${field} organization identity`,
    );
    assertAnyTokens(
      combinedTokens,
      candidate.roleTitle,
      `${field} role/title`,
    );
    const associated =
      (websiteHost && domainsAssociated(emailDomain, websiteHost)) ||
      sources.some((source) => {
        const sourceHost = new URL(source.url).hostname;
        const sourceTokens = new Set(source.contentTokens);
        return (
          domainsAssociated(emailDomain, sourceHost) &&
          normalizedIdentityTokens(context.organizationName).every((token) =>
            sourceTokens.has(token),
          )
        );
      });
    if (!associated) {
      throw new Error(
        `${field}.email domain is not associated with the submitted organization business domain`,
      );
    }

    if (candidate.discoveryMethod !== "domain_pattern") {
      if (
        !sources.some((source) =>
          source.observedEmails.includes(normalizedEmail),
        )
      ) {
        throw new Error(
          `${field}.email does not appear in broker-fetched source content`,
        );
      }
      continue;
    }

    if (
      candidate.confidence !== "low" ||
      !candidate.patternEvidenceUrl ||
      !Array.isArray(candidate.patternExamples) ||
      candidate.patternExamples.length < 2 ||
      candidate.patternExamples.length > 5
    ) {
      throw new Error(
        `${field} domain-pattern inference requires low confidence and 2 to 5 published examples`,
      );
    }
    const patternUrl = canonicalPublicHttpsUrl(
      candidate.patternEvidenceUrl,
      `${field}.patternEvidenceUrl`,
    );
    const patternSource = parsed.sourceByUrl.get(patternUrl);
    if (!patternSource || !sourceUrls.includes(patternUrl)) {
      throw new Error(
        `${field}.patternEvidenceUrl must be a fetched candidate source`,
      );
    }
    const patternTokens = new Set(patternSource.contentTokens);
    let commonPatterns = null;
    const seenExampleEmails = new Set();
    for (const [exampleIndex, example] of candidate.patternExamples.entries()) {
      if (!example || typeof example !== "object" || Array.isArray(example)) {
        throw new Error(`${field}.patternExamples[${exampleIndex}] is invalid`);
      }
      const exampleEmail = assertNamedBusinessEmail(
        example.email,
        `${field}.patternExamples[${exampleIndex}].email`,
      );
      if (
        seenExampleEmails.has(exampleEmail) ||
        exampleEmail.split("@")[1] !== emailDomain ||
        !patternSource.observedEmails.includes(exampleEmail)
      ) {
        throw new Error(
          `${field}.patternExamples must be distinct published addresses on the candidate business domain`,
        );
      }
      seenExampleEmails.add(exampleEmail);
      assertAllTokens(
        patternTokens,
        [example.personName],
        `${field}.patternExamples[${exampleIndex}] person identity`,
      );
      const matches = new Set(
        emailPatternMatches(example.personName, exampleEmail),
      );
      commonPatterns =
        commonPatterns === null
          ? matches
          : new Set(
              [...commonPatterns].filter((pattern) => matches.has(pattern)),
            );
    }
    const candidatePatterns = new Set(
      emailPatternMatches(context.personName, normalizedEmail),
    );
    if (
      !commonPatterns ||
      commonPatterns.size === 0 ||
      ![...commonPatterns].some((pattern) =>
        candidatePatterns.has(pattern),
      )
    ) {
      throw new Error(
        `${field}.email does not follow the published organization email pattern`,
      );
    }
  }
  return parsed;
}
