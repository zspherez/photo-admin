import { applyHtmlTemplate, type TemplateVars } from "@/lib/template";

export const EMAIL_UTM_DEFAULTS = {
  utm_source: "photo_admin",
  utm_medium: "email",
  utm_campaign_original: "outreach",
  utm_campaign_follow_up: "follow_up",
} as const;

export const EMAIL_UTM_SETTING_KEYS = Object.keys(
  EMAIL_UTM_DEFAULTS,
) as (keyof typeof EMAIL_UTM_DEFAULTS)[];

export type EmailUtmSettingKey = (typeof EMAIL_UTM_SETTING_KEYS)[number];
export type EmailUtmSettings = Record<EmailUtmSettingKey, string>;
export type EmailUtmKind = "original" | "follow_up";

export function resolveEmailUtmSettings(
  storedValues: Partial<Record<EmailUtmSettingKey, string>>,
): EmailUtmSettings {
  return Object.fromEntries(
    EMAIL_UTM_SETTING_KEYS.map((key) => [
      key,
      Object.prototype.hasOwnProperty.call(storedValues, key)
        ? storedValues[key] ?? ""
        : EMAIL_UTM_DEFAULTS[key],
    ]),
  ) as EmailUtmSettings;
}

export function normalizeArtistUtmContent(artistName: string): string {
  return artistName
    .trim()
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

function decodeUrlHtmlEntities(value: string): string {
  return value.replace(
    /&(#(?:x[0-9a-f]+|\d+)|amp|quot|apos|lt|gt);/gi,
    (entity, token: string) => {
      const normalized = token.toLowerCase();
      if (normalized === "amp") return "&";
      if (normalized === "quot") return '"';
      if (normalized === "apos") return "'";
      if (normalized === "lt") return "<";
      if (normalized === "gt") return ">";

      const numeric = normalized.startsWith("#x")
        ? Number.parseInt(normalized.slice(2), 16)
        : Number.parseInt(normalized.slice(1), 10);
      return Number.isFinite(numeric) &&
        numeric > 0 &&
        numeric <= 0x10ffff &&
        !(numeric >= 0xd800 && numeric <= 0xdfff)
        ? String.fromCodePoint(numeric)
        : entity;
    },
  );
}

function encodeUrlHtmlAttribute(value: string, quote: "'" | '"'): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(quote === '"' ? /"/g : /'/g, quote === '"' ? "&quot;" : "&#39;");
}

function trackedHref(
  href: string,
  quote: "'" | '"',
  kind: EmailUtmKind,
  artistName: string,
  settings: EmailUtmSettings,
): string {
  const decodedHref = decodeUrlHtmlEntities(href);
  if (!/^https?:\/\//i.test(decodedHref)) return href;

  let url: URL;
  try {
    url = new URL(decodedHref);
  } catch {
    return href;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !url.hostname
  ) {
    return href;
  }

  const campaign =
    kind === "original"
      ? settings.utm_campaign_original
      : settings.utm_campaign_follow_up;
  const artistContent = normalizeArtistUtmContent(artistName);
  const parameters = [
    ["utm_source", settings.utm_source.trim()],
    ["utm_medium", settings.utm_medium.trim()],
    ["utm_campaign", campaign.trim()],
    ["utm_content", artistContent],
  ] as const;

  let changed = false;
  for (const [key, value] of parameters) {
    if (value && !url.searchParams.has(key)) {
      url.searchParams.append(key, value);
      changed = true;
    }
  }

  return changed ? encodeUrlHtmlAttribute(url.toString(), quote) : href;
}

function transformTagHrefs(
  tag: string,
  kind: EmailUtmKind,
  artistName: string,
  settings: EmailUtmSettings,
): string {
  const opening = tag.match(/^<\s*[A-Za-z][^\s/>]*/);
  if (!opening) return tag;

  let cursor = opening[0].length;
  let output = tag.slice(0, cursor);
  const tagEnd = tag.length - 1;

  while (cursor < tagEnd) {
    const whitespaceStart = cursor;
    while (cursor < tagEnd && /\s/.test(tag[cursor])) cursor += 1;
    output += tag.slice(whitespaceStart, cursor);
    if (cursor >= tagEnd || tag[cursor] === "/") {
      output += tag.slice(cursor);
      return output;
    }

    const nameStart = cursor;
    while (cursor < tagEnd && !/[\s=/>]/.test(tag[cursor])) cursor += 1;
    if (cursor === nameStart) return tag;
    const name = tag.slice(nameStart, cursor);
    output += name;

    const beforeEquals = cursor;
    while (cursor < tagEnd && /\s/.test(tag[cursor])) cursor += 1;
    output += tag.slice(beforeEquals, cursor);
    if (tag[cursor] !== "=") continue;

    output += "=";
    cursor += 1;
    const afterEquals = cursor;
    while (cursor < tagEnd && /\s/.test(tag[cursor])) cursor += 1;
    output += tag.slice(afterEquals, cursor);

    const quote = tag[cursor];
    if (quote !== '"' && quote !== "'") {
      const valueStart = cursor;
      while (cursor < tagEnd && !/[\s>]/.test(tag[cursor])) cursor += 1;
      const value = tag.slice(valueStart, cursor);
      if (name.toLowerCase() !== "href") {
        output += value;
        continue;
      }
      const transformed = trackedHref(
        value,
        '"',
        kind,
        artistName,
        settings,
      );
      output += transformed === value ? value : `"${transformed}"`;
      continue;
    }

    output += quote;
    cursor += 1;
    const valueStart = cursor;
    const valueEnd = tag.indexOf(quote, valueStart);
    if (valueEnd < 0 || valueEnd >= tagEnd) return tag;
    const value = tag.slice(valueStart, valueEnd);
    output +=
      name.toLowerCase() === "href"
        ? trackedHref(
            value,
            quote as "'" | '"',
            kind,
            artistName,
            settings,
          )
        : value;
    output += quote;
    cursor = valueEnd + 1;
  }

  output += tag.slice(cursor);
  return output;
}

export function appendEmailUtmToHtml(
  html: string,
  kind: EmailUtmKind,
  artistName: string,
  settings: EmailUtmSettings,
): string {
  let cursor = 0;
  let output = "";

  while (cursor < html.length) {
    const tagStart = html.indexOf("<", cursor);
    if (tagStart < 0) return output + html.slice(cursor);
    output += html.slice(cursor, tagStart);

    if (html.startsWith("<!--", tagStart)) {
      const commentEnd = html.indexOf("-->", tagStart + 4);
      if (commentEnd < 0) return output + html.slice(tagStart);
      output += html.slice(tagStart, commentEnd + 3);
      cursor = commentEnd + 3;
      continue;
    }

    let quote: "'" | '"' | null = null;
    let tagEnd = tagStart + 1;
    for (; tagEnd < html.length; tagEnd += 1) {
      const character = html[tagEnd];
      if (quote) {
        if (character === quote) quote = null;
      } else if (character === "'" || character === '"') {
        quote = character;
      } else if (character === ">") {
        break;
      }
    }
    if (tagEnd >= html.length || quote) return output + html.slice(tagStart);

    const tag = html.slice(tagStart, tagEnd + 1);
    output += transformTagHrefs(tag, kind, artistName, settings);
    cursor = tagEnd + 1;
  }

  return output;
}

export function renderTrackedEmailHtml(
  templateHtml: string,
  vars: TemplateVars,
  kind: EmailUtmKind,
  artistName: string,
  settings: EmailUtmSettings,
): string {
  return appendEmailUtmToHtml(
    applyHtmlTemplate(templateHtml, vars),
    kind,
    artistName,
    settings,
  );
}
