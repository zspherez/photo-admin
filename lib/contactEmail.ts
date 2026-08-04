import { normalizeEmail } from "@/lib/resend";

const CONTACT_EMAIL_PATTERN =
  /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

export function normalizeContactEmail(value: string): string | null {
  if (/[,;<>]/.test(value)) return null;
  const normalized = normalizeEmail(value);
  return normalized && CONTACT_EMAIL_PATTERN.test(normalized)
    ? normalized
    : null;
}
