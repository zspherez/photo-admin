import { Resend } from "resend";
import { readFileSync, existsSync } from "node:fs";
import { basename } from "node:path";

let _client: Resend | null = null;

function client(): Resend {
  if (_client) return _client;
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("Missing RESEND_API_KEY");
  _client = new Resend(key);
  return _client;
}

export interface SendArgs {
  to: string;
  subject: string;
  html: string;
  outreachId: string;
}

export interface SendResult {
  providerMessageId: string | null;
  error: string | null;
}

export function getTestOverride(): string | null {
  const v = process.env.SEND_TEST_OVERRIDE?.trim();
  return v ? v : null;
}

export interface AttachmentInfo {
  source: string;
  filename: string;
  kind: "url" | "file";
  exists: boolean;
}

export function getRateCardInfo(): AttachmentInfo | null {
  const source = process.env.RATE_CARD_PATH?.trim();
  if (!source) return null;
  if (/^https?:\/\//i.test(source)) {
    const filename = new URL(source).pathname.split("/").pop() || "rate-card.pdf";
    return { source, filename, kind: "url", exists: true };
  }
  return { source, filename: basename(source), kind: "file", exists: existsSync(source) };
}

async function loadAttachments(): Promise<{ filename: string; content: string }[]> {
  const info = getRateCardInfo();
  if (!info) return [];
  try {
    if (info.kind === "url") {
      const res = await fetch(info.source, { cache: "no-store" });
      if (!res.ok) throw new Error(`fetch ${info.source} → ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      return [{ filename: info.filename, content: buf.toString("base64") }];
    }
    if (!info.exists) return [];
    return [{ filename: info.filename, content: readFileSync(info.source).toString("base64") }];
  } catch (e) {
    console.error("[attachments] failed to load rate card", e);
    return [];
  }
}

export async function sendEmailViaResend({ to, subject, html, outreachId }: SendArgs): Promise<SendResult> {
  const from = process.env.RESEND_FROM_EMAIL;
  if (!from) return { providerMessageId: null, error: "Missing RESEND_FROM_EMAIL" };

  const override = getTestOverride();
  const finalTo = override ?? to;
  const finalSubject = override ? `[TEST → ${to}] ${subject}` : subject;
  const attachments = await loadAttachments();

  try {
    const result = await client().emails.send({
      from,
      to: finalTo,
      subject: finalSubject,
      html,
      headers: { "X-Outreach-Id": outreachId },
      tags: [{ name: "outreach_id", value: outreachId }],
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    if (result.error) return { providerMessageId: null, error: String(result.error.message ?? result.error) };
    return { providerMessageId: result.data?.id ?? null, error: null };
  } catch (e) {
    return { providerMessageId: null, error: e instanceof Error ? e.message : String(e) };
  }
}
