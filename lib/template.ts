import { db } from "@/lib/db";

export type TemplateVars = Record<string, string>;

export function applyTemplate(template: string, vars: TemplateVars): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : ""
  );
}

export function extractVars(template: string): string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) {
    found.add(match[1]);
  }
  return Array.from(found).sort();
}

export const DEFAULT_TEMPLATE_NAME = "default";

export const DEFAULT_TEMPLATE_SUBJECT = "Photography for upcoming NYC {{artist}} show";

export const DEFAULT_TEMPLATE_HTML = `<html>
  <body>
    <p>Hey {{manager_name}} - wanted to shoot a quick message over regarding the {{artist}} show in NYC in a few weeks. I am a multimedia creative specialist local to NYC and would love to work together to capture this show!</p>
    <p>Gave a brief summary of my rates/deliverables below, and attached my full rate card to this email but I'm happy to work with you to meet your needs!</p>
    <p>My minimum deliverables include 25 photos and 3-5 clips night of show; complete gallery with 50+ additional photos and 7-10 additional clips the following day.</p>
    <p>My standard NYC show rate is $400 for photo/video, or $200 for just photo, more details in my rate card.</p>
    <p>You can check out some examples of my previous work at <a href="{{portfolio_url}}">https://rehders.photos/</a></p>
    <p>I look forward to hearing from you soon!</p>
    <p>Best,<br>
       Josh Rehders<br>
       <a href="mailto:josh@rehders.photos">josh@rehders.photos</a> // +1.832.405.8765 // <a href="{{portfolio_url}}">https://rehders.photos</a>
    </p>
  </body>
</html>`;

export async function ensureDefaultTemplate() {
  const existing = await db.emailTemplate.findFirst({ where: { isDefault: true } });
  if (existing) return existing;
  return db.emailTemplate.create({
    data: {
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

export async function buildVarsForShow(ctx: ShowContext): Promise<TemplateVars> {
  const portfolioUrl = await getSetting("portfolio_url", "https://rehders.photos");
  return {
    artist: ctx.artistName,
    venue: ctx.venueName,
    date: ctx.showDate.toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
    }),
    rate: ctx.customPrice?.trim() ?? "",
    portfolio_url: portfolioUrl,
    manager_name: ctx.managerName?.trim() || "there",
  };
}
