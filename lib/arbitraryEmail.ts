import { appendUtmParametersToHtml } from "@/lib/emailUtm";
import { normalizeEmail } from "@/lib/resend";

export const ARBITRARY_EMAIL_UTM_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
] as const;

export type ArbitraryEmailUtmKey = (typeof ARBITRARY_EMAIL_UTM_KEYS)[number];
export type ArbitraryEmailUtmValues = Record<ArbitraryEmailUtmKey, string>;

export interface ArbitraryEmailInput {
  recipientEmails: string[];
  subject: string;
  html: string;
  utm: ArbitraryEmailUtmValues;
}

export type ArbitraryEmailInputResult =
  | { ok: true; input: ArbitraryEmailInput }
  | { ok: false; error: string };

export function parseArbitraryEmailInput(values: {
  recipients: string;
  subject: string;
  html: string;
} & Partial<ArbitraryEmailUtmValues>): ArbitraryEmailInputResult {
  const rawRecipients = values.recipients
    .split(/[,;\n]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (rawRecipients.length === 0) {
    return { ok: false, error: "Enter at least one recipient" };
  }
  if (rawRecipients.length > 50) {
    return { ok: false, error: "A maximum of 50 recipients is allowed" };
  }

  const normalized = rawRecipients.map(normalizeEmail);
  if (normalized.some((email) => email === null)) {
    return { ok: false, error: "One or more recipient email addresses are invalid" };
  }
  const recipientEmails = Array.from(new Set(normalized as string[]));
  const subject = values.subject.trim();
  if (!subject) return { ok: false, error: "Enter a subject" };
  if (/[\r\n]/.test(subject) || subject.length > 998) {
    return { ok: false, error: "Subject is invalid or too long" };
  }
  if (!values.html.trim()) return { ok: false, error: "Enter an email body" };
  if (values.html.length > 1_000_000) {
    return { ok: false, error: "Email body is too large" };
  }

  const utm = Object.fromEntries(
    ARBITRARY_EMAIL_UTM_KEYS.map((key) => [key, (values[key] ?? "").trim()]),
  ) as ArbitraryEmailUtmValues;
  if (Object.values(utm).some((value) => value.length > 200)) {
    return { ok: false, error: "UTM values must be 200 characters or fewer" };
  }

  return {
    ok: true,
    input: {
      recipientEmails,
      subject,
      html: appendUtmParametersToHtml(
        values.html,
        ARBITRARY_EMAIL_UTM_KEYS.map((key) => [key, utm[key]]),
      ),
      utm,
    },
  };
}

interface ArbitraryEmailEventState {
  status: string;
  sentAt: Date | null;
  deliveredAt: Date | null;
  firstOpenedAt: Date | null;
  lastOpenedAt: Date | null;
  openCount: number;
  firstClickedAt: Date | null;
  lastClickedAt: Date | null;
  clickCount: number;
  bouncedAt: Date | null;
  complainedAt: Date | null;
}

interface ArbitraryEmailWebhookIdentity {
  arbitraryEmailId: string | null;
  outreachId: string | null;
  attemptId: string | null;
  providerMessageId: string | null;
}

interface ArbitraryEmailWebhookRecord {
  id: string;
  providerMessageId: string | null;
}

export function arbitraryEmailWebhookConflict(
  identity: ArbitraryEmailWebhookIdentity,
  taggedArbitraryEmail: ArbitraryEmailWebhookRecord | null,
  messageArbitraryEmail: ArbitraryEmailWebhookRecord | null,
  messageOutreachAttempt: { id: string } | null,
): string | null {
  if (identity.arbitraryEmailId && !taggedArbitraryEmail) {
    return "tagged arbitrary email not found";
  }
  const arbitraryEmail = taggedArbitraryEmail ?? messageArbitraryEmail;
  if (!arbitraryEmail) return "arbitrary email not found";
  if (identity.outreachId || identity.attemptId) {
    return "arbitrary email identity conflicts with outreach identity";
  }
  if (messageOutreachAttempt) {
    return "provider message belongs to an outreach attempt";
  }
  if (
    taggedArbitraryEmail &&
    messageArbitraryEmail &&
    taggedArbitraryEmail.id !== messageArbitraryEmail.id
  ) {
    return "arbitrary email tag conflicts with provider message";
  }
  if (
    identity.providerMessageId &&
    arbitraryEmail.providerMessageId &&
    arbitraryEmail.providerMessageId !== identity.providerMessageId
  ) {
    return "provider message conflicts with arbitrary email";
  }
  return null;
}

function earlier(current: Date | null, candidate: Date): Date {
  return !current || candidate < current ? candidate : current;
}

function later(current: Date | null, candidate: Date): Date {
  return !current || candidate > current ? candidate : current;
}

export function arbitraryEmailEventUpdate(
  email: ArbitraryEmailEventState & { testSend: boolean },
  type: string,
  occurredAt: Date,
  failureReason?: string,
): Record<string, unknown> {
  switch (type) {
    case "email.sent":
      return {
        status:
          email.status === "failed"
            ? "failed"
            : email.testSend
              ? "test"
              : "sent",
        sentAt: earlier(email.sentAt, occurredAt),
        ...(email.status === "failed" ? {} : { error: null }),
      };
    case "email.delivered":
      return {
        status:
          email.status === "failed"
            ? "failed"
            : email.testSend
              ? "test"
              : "sent",
        sentAt: email.sentAt ?? occurredAt,
        deliveredAt: earlier(email.deliveredAt, occurredAt),
        ...(email.status === "failed" ? {} : { error: null }),
      };
    case "email.opened":
      return {
        firstOpenedAt: earlier(email.firstOpenedAt, occurredAt),
        lastOpenedAt: later(email.lastOpenedAt, occurredAt),
        openCount: { increment: 1 },
      };
    case "email.clicked":
      return {
        firstClickedAt: earlier(email.firstClickedAt, occurredAt),
        lastClickedAt: later(email.lastClickedAt, occurredAt),
        clickCount: { increment: 1 },
      };
    case "email.bounced":
      return {
        status: "failed",
        bouncedAt: earlier(email.bouncedAt, occurredAt),
        error: failureReason ?? "bounce",
      };
    case "email.complained":
      return {
        status: "failed",
        complainedAt: earlier(email.complainedAt, occurredAt),
        error: "complaint",
      };
    case "email.suppressed":
      return email.bouncedAt || email.complainedAt || email.status === "failed"
        ? {}
        : { status: "failed", error: failureReason ?? type };
    case "email.failed":
      return email.status === "failed"
        ? {}
        : { status: "failed", error: failureReason ?? type };
    case "email.delivery_delayed":
      return email.status === "failed" ? {} : { error: type };
    default:
      return {};
  }
}
