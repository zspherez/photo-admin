import { db } from "@/lib/db";
import {
  malformedTemplateVariableTokens,
  normalizeTemplateContent,
  unsupportedTemplateVars,
  type TemplateContent,
} from "@/lib/template";

export function festivalShowTemplateKey(showId: string): string {
  return `festival_show_template:${showId}`;
}

export function validateFestivalShowTemplate(content: TemplateContent): TemplateContent {
  const normalized = normalizeTemplateContent({
    subject: content.subject.trim(),
    htmlBody: content.htmlBody.trim(),
  });
  if (!normalized.subject || !normalized.htmlBody) {
    throw new Error("Festival subject and body are required");
  }
  if (normalized.subject.length > 998 || normalized.htmlBody.length > 100_000) {
    throw new Error("Festival subject or body is too long");
  }
  const malformed = malformedTemplateVariableTokens(normalized);
  if (malformed.length) {
    throw new Error(`Malformed festival variable token(s): ${malformed.join(", ")}`);
  }
  const unsupported = unsupportedTemplateVars(normalized, "festival");
  if (unsupported.length) {
    throw new Error(
      `Unsupported festival variable(s): ${unsupported.map((name) => `{{${name}}}`).join(", ")}`,
    );
  }
  return normalized;
}

export function parseFestivalShowTemplate(value: string): TemplateContent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Saved festival template is invalid; review it before sending");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).sort().join(",") !== "htmlBody,subject" ||
    typeof (parsed as TemplateContent).subject !== "string" ||
    typeof (parsed as TemplateContent).htmlBody !== "string"
  ) {
    throw new Error("Saved festival template is invalid; review it before sending");
  }
  return validateFestivalShowTemplate(parsed as TemplateContent);
}

export async function readFestivalShowTemplate(
  show: { id: string; isFestival: boolean },
  defaultTemplate: TemplateContent,
): Promise<TemplateContent> {
  if (!show.isFestival) return defaultTemplate;
  const setting = await db.setting.findUnique({
    where: { key: festivalShowTemplateKey(show.id) },
    select: { value: true },
  });
  return setting ? parseFestivalShowTemplate(setting.value) : defaultTemplate;
}

export async function saveFestivalShowTemplate(
  showId: string,
  content: TemplateContent,
): Promise<void> {
  const validated = validateFestivalShowTemplate(content);
  await db.setting.upsert({
    where: { key: festivalShowTemplateKey(showId) },
    update: { value: JSON.stringify(validated) },
    create: { key: festivalShowTemplateKey(showId), value: JSON.stringify(validated) },
  });
}
