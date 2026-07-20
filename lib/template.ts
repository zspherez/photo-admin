import type { EmailTemplate } from "@prisma/client";
import { db } from "@/lib/db";

export type TemplateVars = Record<string, string>;

const LEGACY_RATE_TEMPLATE_VARIABLE = /\{\{\s*rate\s*\}\}/gi;
const LEGACY_RATE_TEMPLATE_PARAGRAPH =
  /<p\b[^>]*>(?:(?!<\/?p\b)[\s\S])*?\{\{\s*rate\s*\}\}(?:(?!<\/?p\b)[\s\S])*?<\/p\s*>/gi;
const LEGACY_RENDERED_RATE_PARAGRAPH =
  /<p\b[^>]*>\s*My standard (?:(?!<\/?p\b)[\s\S])*? show rate is (?:(?!<\/?p\b)[\s\S])*?<\/p\s*>/gi;
const LEGACY_RATE_SUMMARY_PARAGRAPH =
  /<p\b[^>]*>Gave a brief summary of my rates\/deliverables below, and (?:attached my full rate card to this email but )?I'm happy to work with you to meet your needs!<\/p\s*>/gi;
const TEMPLATE_VARIABLE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
const LEGACY_RATE_TEMPLATE_VARIABLE_TEST = /\{\{\s*rate\s*\}\}/i;
const HTML_PARAGRAPH =
  /<p\b[^>]*>(?:(?!<\/?p\b)[\s\S])*?<\/p\s*>/gi;
const DEFINITE_RATE_CONTEXT = /\b(?:rate card|custom price)\b/i;
const RATE_WORD = /\brates?\b/i;
const SERVICE_RATE_CONTEXT =
  /\b(?:my|our|standard|show|coverage|photo|video|shoot|hourly|daily|deliverables)\b.{0,40}\brates?\b|\brates?\b.{0,40}\b(?:photo|video|show|coverage|shoot|negotiable|tbd|deliverables)\b|\brates?\s*:/i;
const AMBIGUOUS_RATE_CONTEXT =
  /\b(?:fee|quote|estimate|budget|pricing)\b/i;
const SERVICE_PRICE_CONTEXT =
  /\b(?:my|our|standard|show|coverage|photo|video|shoot)\b.{0,40}\b(?:price|cost)\b|\b(?:price|cost)\b.{0,40}\b(?:my|our|standard|show|coverage|photo|video|shoot)\b/i;
const UNRELATED_PRICE_CONTEXT =
  /\b(?:ticket|admission|merch|travel|equipment|production)\s+(?:price|fee|cost)\b/i;
const CURRENCY_VALUE =
  /(?:[$€£]\s*\d|\b\d+(?:\.\d{1,2})?\s*(?:USD|dollars?)\b)/i;
const DEFAULT_DELIVERABLES_SUMMARY =
  "<p>Here's a brief summary of my deliverables, and I'm happy to work with you to meet your needs!</p>";

export const SUPPORTED_TEMPLATE_VARS = [
  "artist",
  "venue",
  "date",
  "portfolio_url",
  "sender_name",
  "sender_email",
  "sender_phone",
  "sender_city",
  "manager_name",
] as const;

export function normalizeLegacyRateTemplateVariable(template: string): string {
  return template.replace(LEGACY_RATE_TEMPLATE_VARIABLE, "");
}

export function normalizeLegacyRateTemplateHtml(template: string): string {
  return normalizeLegacyRateTemplateVariable(
    template
      .replace(LEGACY_RATE_TEMPLATE_PARAGRAPH, "")
      .replace(LEGACY_RENDERED_RATE_PARAGRAPH, "")
      .replace(
        LEGACY_RATE_SUMMARY_PARAGRAPH,
        DEFAULT_DELIVERABLES_SUMMARY,
      ),
  );
}

function substituteTemplate(
  template: string,
  vars: TemplateVars,
  transform: (value: string) => string
): string {
  return normalizeLegacyRateTemplateVariable(template).replace(
    /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
    (_m, key) =>
      Object.prototype.hasOwnProperty.call(vars, key)
        ? transform(vars[key])
        : ""
  );
}

export function applyTemplate(template: string, vars: TemplateVars): string {
  return substituteTemplate(template, vars, (value) => value);
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function templatePattern(
  template: string,
  captureVariables: boolean,
  variablePattern = "[\\s\\S]*?",
): { pattern: string; variables: string[] } {
  let pattern = "";
  let cursor = 0;
  const variables: string[] = [];
  for (const match of template.matchAll(TEMPLATE_VARIABLE)) {
    pattern += escapeRegExp(template.slice(cursor, match.index));
    variables.push(match[1].toLowerCase());
    pattern += captureVariables ? `(${variablePattern})` : variablePattern;
    cursor = (match.index ?? 0) + match[0].length;
  }
  pattern += escapeRegExp(template.slice(cursor));
  return { pattern, variables };
}

function normalizeRenderedSubjectFromTemplate(
  subject: string,
  template: string,
): string | null {
  const tokens = Array.from(template.matchAll(TEMPLATE_VARIABLE));
  for (let index = 1; index < tokens.length; index += 1) {
    const previous = tokens[index - 1];
    const current = tokens[index];
    const between = template.slice(
      (previous.index ?? 0) + previous[0].length,
      current.index,
    );
    if (
      between.length === 0 &&
      (previous[1].toLowerCase() === "rate" ||
        current[1].toLowerCase() === "rate")
    ) {
      return null;
    }
  }

  const { pattern, variables } = templatePattern(template, true);
  const match = new RegExp(`^${pattern}$`, "i").exec(subject);
  if (!match) return null;

  let normalized = "";
  let cursor = 0;
  let capture = 1;
  for (const token of template.matchAll(TEMPLATE_VARIABLE)) {
    normalized += template.slice(cursor, token.index);
    if (token[1].toLowerCase() !== "rate") {
      normalized += match[capture] ?? "";
    }
    capture += 1;
    cursor = (token.index ?? 0) + token[0].length;
  }
  normalized += template.slice(cursor);
  return variables.includes("rate") ? normalized : null;
}

function legacyRateTemplateParagraphs(template: string): string[] {
  return Array.from(
    new Set(template.match(LEGACY_RATE_TEMPLATE_PARAGRAPH) ?? []),
  );
}

function removeRenderedTemplateParagraph(
  html: string,
  templateParagraph: string,
): { html: string; removed: boolean } {
  const { pattern } = templatePattern(
    templateParagraph,
    false,
    "(?:(?!<\\/?p\\b)[\\s\\S])*?",
  );
  let removed = false;
  return {
    html: html.replace(new RegExp(pattern, "gi"), () => {
      removed = true;
      return "";
    }),
    removed,
  };
}

type LegacyRateContext = "explicit" | "ambiguous" | null;

function legacyRateContext(value: string): LegacyRateContext {
  if (
    DEFINITE_RATE_CONTEXT.test(value) ||
    (RATE_WORD.test(value) &&
      (CURRENCY_VALUE.test(value) || SERVICE_RATE_CONTEXT.test(value)))
  ) {
    return "explicit";
  }
  if (UNRELATED_PRICE_CONTEXT.test(value)) return null;
  if (
    CURRENCY_VALUE.test(value) &&
    (AMBIGUOUS_RATE_CONTEXT.test(value) ||
      SERVICE_PRICE_CONTEXT.test(value))
  ) {
    return "ambiguous";
  }
  return null;
}

export interface LegacyOutreachSnapshotInput {
  subject: string;
  html: string;
  trustedTemplateSubject?: string | null;
  trustedTemplateHtml?: string | null;
}

export type LegacyOutreachSnapshotClassification =
  | {
      outcome: "safe_unchanged";
      subject: string;
      html: string;
    }
  | {
      outcome: "safely_normalized";
      subject: string;
      html: string;
    }
  | {
      outcome: "requires_manual_review";
      subject: string;
      html: string;
    };

export function normalizeLegacyOutreachSnapshot(
  input: LegacyOutreachSnapshotInput,
): LegacyOutreachSnapshotClassification {
  let subject = normalizeLegacyRateTemplateVariable(input.subject);
  let html = normalizeLegacyRateTemplateHtml(input.html);
  let normalized = subject !== input.subject || html !== input.html;
  let requiresManualReview = false;

  if (
    input.trustedTemplateSubject &&
    LEGACY_RATE_TEMPLATE_VARIABLE_TEST.test(input.trustedTemplateSubject)
  ) {
    const normalizedSubject = normalizeRenderedSubjectFromTemplate(
      input.subject,
      input.trustedTemplateSubject,
    );
    if (normalizedSubject === null) requiresManualReview = true;
    else {
      subject = normalizedSubject;
      normalized = true;
    }
  }

  if (
    input.trustedTemplateHtml &&
    LEGACY_RATE_TEMPLATE_VARIABLE_TEST.test(input.trustedTemplateHtml)
  ) {
    const paragraphs = legacyRateTemplateParagraphs(
      input.trustedTemplateHtml,
    );
    const hasUnsupportedPlacement =
      LEGACY_RATE_TEMPLATE_VARIABLE_TEST.test(
        input.trustedTemplateHtml.replace(
          LEGACY_RATE_TEMPLATE_PARAGRAPH,
          "",
        ),
      );
    if (hasUnsupportedPlacement) requiresManualReview = true;
    for (const paragraph of paragraphs) {
      const result = removeRenderedTemplateParagraph(html, paragraph);
      html = result.html;
      if (result.removed) normalized = true;
      if (
        !result.removed &&
        !LEGACY_RATE_TEMPLATE_VARIABLE_TEST.test(input.html)
      ) {
        requiresManualReview = true;
      }
    }
  }

  html = html.replace(HTML_PARAGRAPH, (paragraph) => {
    const context = legacyRateContext(paragraph.replace(/<[^>]*>/g, " "));
    if (context === "explicit") {
      normalized = true;
      return "";
    }
    if (context === "ambiguous") requiresManualReview = true;
    return paragraph;
  });

  if (legacyRateContext(subject)) requiresManualReview = true;
  const textOutsideParagraphs = html
    .replace(HTML_PARAGRAPH, " ")
    .replace(/<[^>]*>/g, " ");
  if (legacyRateContext(textOutsideParagraphs)) {
    requiresManualReview = true;
  }

  if (requiresManualReview) {
    return {
      outcome: "requires_manual_review",
      subject: input.subject,
      html: input.html,
    };
  }
  return normalized
    ? { outcome: "safely_normalized", subject, html }
    : {
        outcome: "safe_unchanged",
        subject: input.subject,
        html: input.html,
      };
}

export function applyHtmlTemplate(template: string, vars: TemplateVars): string {
  return substituteTemplate(
    normalizeLegacyRateTemplateHtml(template),
    vars,
    escapeHtml,
  );
}

export function extractVars(template: string): string[] {
  const found = new Set<string>();
  for (const match of normalizeLegacyRateTemplateVariable(template).matchAll(
    /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g
  )) {
    found.add(match[1]);
  }
  return Array.from(found).sort();
}

export const DEFAULT_TEMPLATE_NAME = "default";
export const FOLLOW_UP_TEMPLATE_NAME = "follow_up";

export const DEFAULT_TEMPLATE_SUBJECT =
  "{{artist}} {{sender_city}} Photo/Video";

const LEGACY_FIXED_RATE_DEFAULT_TEMPLATE_HTML = `<html>
  <body>
    <p>Hey {{manager_name}} - wanted to shoot a quick message over regarding the {{artist}} show in {{sender_city}} in a few weeks. I am a multimedia creative specialist local to {{sender_city}} and would love to work together to capture this show!</p>
    <p>Gave a brief summary of my rates/deliverables below, and attached my full rate card to this email but I'm happy to work with you to meet your needs!</p>
    <p>My minimum deliverables include 25 photos and 3-5 clips night of show; complete gallery with 50+ additional photos and 7-10 additional clips the following day.</p>
    <p>My standard {{sender_city}} show rate is $400 for photo/video, or $200 for just photo, more details in my rate card.</p>
    <p>You can check out some examples of my previous work at <a href="{{portfolio_url}}">{{portfolio_url}}</a></p>
    <p>I look forward to hearing from you soon!</p>
    <p>Best,<br>
       {{sender_name}}<br>
       <a href="mailto:{{sender_email}}">{{sender_email}}</a> // {{sender_phone}} // <a href="{{portfolio_url}}">{{portfolio_url}}</a>
    </p>
  </body>
</html>`;

const LEGACY_VARIABLE_RATE_DEFAULT_TEMPLATE_HTML = `<html>
  <body>
    <p>Hey {{manager_name}} - wanted to shoot a quick message over regarding the {{artist}} show in {{sender_city}} in a few weeks. I am a multimedia creative specialist local to {{sender_city}} and would love to work together to capture this show!</p>
    <p>Gave a brief summary of my rates/deliverables below, and I'm happy to work with you to meet your needs!</p>
    <p>My minimum deliverables include 25 photos and 3-5 clips night of show; complete gallery with 50+ additional photos and 7-10 additional clips the following day.</p>
    <p>My standard {{sender_city}} show rate is {{rate}} for photo/video, or $200 for just photo.</p>
    <p>You can check out some examples of my previous work at <a href="{{portfolio_url}}">{{portfolio_url}}</a></p>
    <p>I look forward to hearing from you soon!</p>
    <p>Best,<br>
       {{sender_name}}<br>
       <a href="mailto:{{sender_email}}">{{sender_email}}</a> // {{sender_phone}} // <a href="{{portfolio_url}}">{{portfolio_url}}</a>
    </p>
  </body>
</html>`;

export const DEFAULT_TEMPLATE_HTML = `<html>
  <body>
    <p>Hey {{manager_name}} - wanted to shoot a quick message over regarding the {{artist}} show in {{sender_city}} in a few weeks. I am a multimedia creative specialist local to {{sender_city}} and would love to work together to capture this show!</p>
    ${DEFAULT_DELIVERABLES_SUMMARY}
    <p>My minimum deliverables include 25 photos and 3-5 clips night of show; complete gallery with 50+ additional photos and 7-10 additional clips the following day.</p>
    <p>You can check out some examples of my previous work at <a href="{{portfolio_url}}">{{portfolio_url}}</a></p>
    <p>I look forward to hearing from you soon!</p>
    <p>Best,<br>
       {{sender_name}}<br>
       <a href="mailto:{{sender_email}}">{{sender_email}}</a> // {{sender_phone}} // <a href="{{portfolio_url}}">{{portfolio_url}}</a>
    </p>
  </body>
</html>`;

export interface TemplateContent {
  subject: string;
  htmlBody: string;
}

export function normalizeTemplateContent(
  template: TemplateContent
): TemplateContent {
  return {
    subject: normalizeLegacyRateTemplateVariable(template.subject),
    htmlBody: normalizeLegacyRateTemplateHtml(template.htmlBody),
  };
}

export function normalizeDefaultTemplateContent(
  template: TemplateContent
): TemplateContent {
  const normalized = normalizeTemplateContent(template);
  if (
    template.htmlBody === LEGACY_FIXED_RATE_DEFAULT_TEMPLATE_HTML ||
    template.htmlBody === LEGACY_VARIABLE_RATE_DEFAULT_TEMPLATE_HTML
  ) {
    return {
      subject: normalized.subject,
      htmlBody: DEFAULT_TEMPLATE_HTML,
    };
  }
  return normalized;
}

export function cloneTemplateContent(
  template: TemplateContent
): TemplateContent {
  return {
    subject: template.subject,
    htmlBody: template.htmlBody,
  };
}

async function persistNormalizedTemplate(
  template: EmailTemplate,
  normalize: (content: TemplateContent) => TemplateContent
): Promise<EmailTemplate> {
  const content = normalize(template);
  if (
    content.subject === template.subject &&
    content.htmlBody === template.htmlBody
  ) {
    return template;
  }
  return db.emailTemplate.update({
    where: { id: template.id },
    data: content,
  });
}

export async function ensureDefaultTemplate() {
  const existing = await db.emailTemplate.findFirst({ where: { isDefault: true } });
  if (existing) {
    return persistNormalizedTemplate(existing, normalizeDefaultTemplateContent);
  }
  const template = await db.emailTemplate.upsert({
    where: { name: DEFAULT_TEMPLATE_NAME },
    update: { isDefault: true },
    create: {
      name: DEFAULT_TEMPLATE_NAME,
      subject: DEFAULT_TEMPLATE_SUBJECT,
      htmlBody: DEFAULT_TEMPLATE_HTML,
      isDefault: true,
    },
  });
  return persistNormalizedTemplate(template, normalizeDefaultTemplateContent);
}

export async function ensureFollowUpTemplate() {
  const existing = await db.emailTemplate.findUnique({
    where: { name: FOLLOW_UP_TEMPLATE_NAME },
  });
  if (existing) {
    return persistNormalizedTemplate(
      existing,
      normalizeDefaultTemplateContent,
    );
  }

  const original = await ensureDefaultTemplate();
  const content = cloneTemplateContent(original);
  return db.emailTemplate.upsert({
    where: { name: FOLLOW_UP_TEMPLATE_NAME },
    update: {},
    create: {
      name: FOLLOW_UP_TEMPLATE_NAME,
      ...content,
      isDefault: false,
    },
  });
}

export async function getSetting(key: string, fallback: string): Promise<string> {
  const s = await db.setting.findUnique({ where: { key } });
  return s?.value ?? fallback;
}

export interface ShowContext {
  artistName: string;
  venueName: string;
  showDate: Date;
  managerName: string | null;
}

export async function buildVarsForShow(
  ctx: ShowContext,
  readSetting: typeof getSetting = getSetting
): Promise<TemplateVars> {
  const [
    portfolioUrl,
    senderName,
    senderEmail,
    senderPhone,
    senderCity,
  ] = await Promise.all([
    readSetting("portfolio_url", ""),
    readSetting("sender_name", ""),
    readSetting("sender_email", ""),
    readSetting("sender_phone", ""),
    readSetting("sender_city", ""),
  ]);
  return {
    artist: ctx.artistName,
    venue: ctx.venueName,
    date: ctx.showDate.toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    }),
    portfolio_url: portfolioUrl,
    sender_name: senderName,
    sender_email: senderEmail,
    sender_phone: senderPhone,
    sender_city: senderCity,
    manager_name: ctx.managerName?.trim() || "there",
  };
}
