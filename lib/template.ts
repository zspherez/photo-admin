import { db } from "@/lib/db";

export type TemplateVars = Record<string, string>;

function substituteTemplate(
  template: string,
  vars: TemplateVars,
  transform: (value: string) => string
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? transform(vars[key]) : ""
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

export function applyHtmlTemplate(template: string, vars: TemplateVars): string {
  return substituteTemplate(template, vars, escapeHtml);
}

export function extractVars(template: string): string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) {
    found.add(match[1]);
  }
  return Array.from(found).sort();
}

export const DEFAULT_TEMPLATE_NAME = "default";

export const DEFAULT_TEMPLATE_SUBJECT = "{{artist}} {{sender_city}} Photo/Video";

const LEGACY_DEFAULT_TEMPLATE_HTML = `<html>
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

export const DEFAULT_TEMPLATE_HTML = `<html>
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

export async function ensureDefaultTemplate() {
  const existing = await db.emailTemplate.findFirst({ where: { isDefault: true } });
  if (existing) {
    if (
      existing.name === DEFAULT_TEMPLATE_NAME &&
      existing.htmlBody === LEGACY_DEFAULT_TEMPLATE_HTML
    ) {
      return db.emailTemplate.update({
        where: { id: existing.id },
        data: { htmlBody: DEFAULT_TEMPLATE_HTML },
      });
    }
    return existing;
  }
  return db.emailTemplate.upsert({
    where: { name: DEFAULT_TEMPLATE_NAME },
    update: { isDefault: true },
    create: {
      name: DEFAULT_TEMPLATE_NAME,
      subject: DEFAULT_TEMPLATE_SUBJECT,
      htmlBody: DEFAULT_TEMPLATE_HTML,
      isDefault: true,
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
  customPrice: string | null;
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
    defaultRate,
  ] = await Promise.all([
    readSetting("portfolio_url", ""),
    readSetting("sender_name", ""),
    readSetting("sender_email", ""),
    readSetting("sender_phone", ""),
    readSetting("sender_city", ""),
    readSetting("default_rate", "$400"),
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
    rate: ctx.customPrice?.trim() || defaultRate.trim(),
    portfolio_url: portfolioUrl,
    sender_name: senderName,
    sender_email: senderEmail,
    sender_phone: senderPhone,
    sender_city: senderCity,
    manager_name: ctx.managerName?.trim() || "there",
  };
}
