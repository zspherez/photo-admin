import { Resend } from "resend";
import { db } from "@/lib/db";

let _client: Resend | null = null;

function client(): Resend {
  if (_client) return _client;
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("Missing RESEND_API_KEY");
  _client = new Resend(key);
  return _client;
}

export interface SendArgs {
  to: string | string[];
  subject: string;
  html: string;
  outreachId: string;
}

export interface SendResult {
  providerMessageId: string | null;
  error: string | null;
}

// Test override email: when set, every send is redirected here.
// DB setting wins over env (so the UI toggle is the source of truth).
// Empty DB value explicitly disables; missing DB entry falls back to env.
export async function getTestOverride(): Promise<string | null> {
  const setting = await db.setting.findUnique({ where: { key: "test_override_email" } });
  if (setting !== null) return setting.value.trim() || null;
  const env = process.env.SEND_TEST_OVERRIDE?.trim();
  return env ? env : null;
}

// BCC addresses (comma-separated in DB). Copied on every real send.
export async function getBccEmails(): Promise<string[]> {
  const setting = await db.setting.findUnique({ where: { key: "bcc_emails" } });
  const raw = setting?.value ?? "";
  return raw
    .split(/[\s,;]+/)
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.includes("@") && e.length >= 5);
}

export async function sendEmailViaResend({ to, subject, html, outreachId }: SendArgs): Promise<SendResult> {
  const from = process.env.RESEND_FROM_EMAIL;
  if (!from) return { providerMessageId: null, error: "Missing RESEND_FROM_EMAIL" };

  const [override, bcc] = await Promise.all([getTestOverride(), getBccEmails()]);
  const toList = Array.isArray(to) ? to : [to];
  const finalTo: string | string[] = override ? override : toList.length === 1 ? toList[0] : toList;
  const finalSubject = override ? `[TEST → ${toList.join(", ")}] ${subject}` : subject;
  // In test mode, skip BCC — don't accidentally CC your real address on test sends.
  const finalBcc = override ? [] : bcc;

  try {
    const result = await client().emails.send({
      from,
      to: finalTo,
      subject: finalSubject,
      html,
      headers: { "X-Outreach-Id": outreachId },
      tags: [{ name: "outreach_id", value: outreachId }],
      ...(finalBcc.length > 0 ? { bcc: finalBcc.length === 1 ? finalBcc[0] : finalBcc } : {}),
    });
    if (result.error) return { providerMessageId: null, error: String(result.error.message ?? result.error) };
    return { providerMessageId: result.data?.id ?? null, error: null };
  } catch (e) {
    return { providerMessageId: null, error: e instanceof Error ? e.message : String(e) };
  }
}
