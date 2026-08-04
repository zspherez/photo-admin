import { createHash } from "node:crypto";
import {
  canonicalPublicHttpsUrl,
  normalizedIdentityTokens,
} from "../lib/professionalContactProvenance.mjs";

function contentTokens(result) {
  return Array.from(
    new Set(
      normalizedIdentityTokens(`${result.title ?? ""} ${result.text ?? ""}`),
    ),
  ).slice(0, 5_000);
}

function observedDomains(result, observedEmails) {
  const domains = new Set(
    observedEmails.map((email) => email.split("@").at(-1)).filter(Boolean),
  );
  for (const link of Array.isArray(result.links) ? result.links : []) {
    try {
      if (typeof link.url === "string" && link.url.startsWith("https://")) {
        domains.add(
          new URL(link.url).hostname.toLowerCase().replace(/^www\./, ""),
        );
      }
    } catch {
      // Ignore malformed links returned by untrusted pages.
    }
  }
  const textDomains =
    String(result.text ?? "")
      .toLowerCase()
      .match(/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}/g) ?? [];
  textDomains.forEach((domain) => domains.add(domain.replace(/^www\./, "")));
  return [...domains].slice(0, 100);
}

function pageBlocks(result) {
  const blocks =
    Array.isArray(result.blocks) && result.blocks.length > 0
      ? result.blocks
      : [`${result.title ?? ""} ${result.text ?? ""}`];
  return blocks
    .map((text) => String(text).replace(/\s+/g, " ").trim())
    .filter((text) => text.length >= 2 && text.length <= 2_000)
    .map((text) => ({
      text,
      blockSha256: createHash("sha256").update(text).digest("hex"),
      contentTokens: Array.from(
        new Set(normalizedIdentityTokens(text)),
      ).slice(0, 500),
      emails: Array.from(
        new Set(
          text
            .toLowerCase()
            .match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) ?? [],
        ),
      ),
    }))
    .slice(0, 500);
}

function normalizedPhrase(value) {
  return normalizedIdentityTokens(value).join(" ");
}

const RECORD_CONTEXT_TOKENS = new Set([
  "and",
  "at",
  "contact",
  "email",
  "for",
  "is",
  "of",
  "official",
  "reach",
  "staff",
  "team",
  "the",
  "via",
]);
const COMMON_ROLE_TOKENS = new Set([
  "advisor",
  "assistant",
  "chief",
  "cofounder",
  "coo",
  "ceo",
  "cto",
  "director",
  "editor",
  "executive",
  "founder",
  "manager",
  "officer",
  "owner",
  "partner",
  "president",
  "producer",
  "vp",
]);

function blockHasOtherDistinctPerson(block, identity) {
  const claimedPersonTokens = new Set(
    normalizedIdentityTokens(identity.personName),
  );
  const nonPersonAllowed = new Set([
    ...normalizedIdentityTokens(identity.organizationName),
    ...normalizedIdentityTokens(identity.roleTitle ?? ""),
    ...RECORD_CONTEXT_TOKENS,
    ...COMMON_ROLE_TOKENS,
  ]);
  const emailDomain = block.emails[0]?.split("@")[1] ?? "";
  normalizedIdentityTokens(emailDomain).forEach((token) =>
    nonPersonAllowed.add(token),
  );
  const structuralSegments = block.text
    .split(/\s*(?:\||•|·|;|\/|—|–|\s-\s)\s*/u)
    .map((segment) => normalizedIdentityTokens(segment))
    .filter((tokens) => tokens.length > 0);
  for (const tokens of structuralSegments) {
    const identityTokens = tokens.filter(
      (token) =>
        !claimedPersonTokens.has(token) &&
        !nonPersonAllowed.has(token) &&
        !/^\d+$/.test(token),
    );
    if (identityTokens.length >= 2) return true;

    const claimedOverlap = tokens.filter((token) =>
      claimedPersonTokens.has(token),
    );
    const distinctTokens = tokens.filter(
      (token) =>
        !claimedPersonTokens.has(token) &&
        !nonPersonAllowed.has(token) &&
        !/^\d+$/.test(token),
    );
    if (claimedOverlap.length > 0 && distinctTokens.length > 0) {
      return true;
    }
  }
  return false;
}

export function emailAssociation(source, email, identity) {
  const personPhrase = normalizedPhrase(identity.personName);
  const matches = source.blocks.filter(
    (block) =>
      block.emails.length === 1 &&
      block.emails[0] === email &&
      normalizedPhrase(block.text).includes(personPhrase) &&
      !blockHasOtherDistinctPerson(block, identity),
  );
  if (matches.length !== 1) return null;
  const [block] = matches;
  return {
    email,
    excerptSha256: block.blockSha256,
    contentTokens: block.contentTokens,
  };
}

function primaryEntityTokens(result, url) {
  const parsed = new URL(url);
  const linkedInSlug = parsed.pathname.match(/^\/company\/([^/]+)/)?.[1];
  const titlePrimary = String(result.title ?? "")
    .split(/\s+[|—–]\s+/)[0]
    .replace(/\s+-\s+LinkedIn$/i, "");
  const titleTokens = normalizedIdentityTokens(titlePrimary).filter(
    (token) =>
      !new Set([
        "facebook",
        "instagram",
        "linkedin",
        "twitter",
      ]).has(token),
  );
  const slugTokens = normalizedIdentityTokens(
    linkedInSlug?.replace(/[-_]+/g, " ") ?? "",
  );
  return Array.from(
    new Set([...titleTokens, ...slugTokens]),
  ).slice(0, 50);
}

export function ownershipStatement(source, domain, organizationName) {
  const ownershipPattern =
    /\b(?:official (?:website|(?:email )?domain|site)|(?:our|company|organization) (?:website|domain)|we (?:use|own|operate|control)|owned by|operated by|controlled by|website\s*:)/i;
  const organizationTokens = normalizedIdentityTokens(organizationName);
  const matches = source.blocks.filter(
    (block) =>
      block.text.toLowerCase().includes(domain.toLowerCase()) &&
      ownershipPattern.test(block.text) &&
      organizationTokens.every((token) =>
        block.contentTokens.includes(token),
      ),
  );
  if (matches.length !== 1) return null;
  return {
    domain,
    blockSha256: matches[0].blockSha256,
    contentTokens: matches[0].contentTokens,
  };
}

export function claimBoundPrimaryEntityTokens(source) {
  return [...source.primaryEntityTokens];
}

export function buildFetchedSourceRecord(result) {
  const url = canonicalPublicHttpsUrl(result.url);
  const observedEmails = Array.from(
    new Set(
      (Array.isArray(result.emails) ? result.emails : []).map((email) =>
        String(email).trim().toLowerCase(),
      ),
    ),
  );
  return {
    url,
    observedEmails,
    observedDomains: observedDomains(result, observedEmails),
    primaryEntityTokens: primaryEntityTokens(result, url),
    blocks: pageBlocks(result),
    contentTokens: contentTokens(result),
    contentSha256: createHash("sha256")
      .update(
        JSON.stringify({
          title: result.title ?? "",
          text: result.text ?? "",
          observedEmails,
        }),
      )
      .digest("hex"),
  };
}
