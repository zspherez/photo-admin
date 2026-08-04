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

function blockHasOtherDistinctPerson(block, personName, organizationName) {
  const personTokens = new Set(normalizedIdentityTokens(personName));
  const organization = normalizedPhrase(organizationName);
  const phrases =
    block.text.match(
      /\b[A-Z][\p{Ll}\p{M}'’-]+(?:\s+[A-Z][\p{Ll}\p{M}'’-]+){1,3}\b/gu,
    ) ?? [];
  return phrases.some((phrase) => {
    const normalized = normalizedPhrase(phrase);
    const tokens = normalizedIdentityTokens(phrase);
    return (
      normalized !== normalizedPhrase(personName) &&
      normalized !== organization &&
      !tokens.some((token) => personTokens.has(token))
    );
  });
}

export function emailAssociation(source, email, identity) {
  const personPhrase = normalizedPhrase(identity.personName);
  const matches = source.blocks.filter(
    (block) =>
      block.emails.length === 1 &&
      block.emails[0] === email &&
      normalizedPhrase(block.text).includes(personPhrase) &&
      !blockHasOtherDistinctPerson(
        block,
        identity.personName,
        identity.organizationName,
      ),
  );
  if (matches.length !== 1) return null;
  const [block] = matches;
  return {
    email,
    excerptSha256: block.blockSha256,
    contentTokens: block.contentTokens,
  };
}

export function ownershipStatement(source, domain, organizationName) {
  const ownershipPattern =
    /\b(?:official (?:website|(?:email )?domain|site)|(?:our|company|organization) (?:website|domain)|we (?:use|own|operate|control)|owned by|operated by|controlled by|website\s*:)\b/i;
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
