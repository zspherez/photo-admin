import { createHash } from "node:crypto";

export const SENT_MAIL_COPY_ENABLED_KEY = "sent_mail_copy_enabled";
export const SENT_MAIL_COPY_MAILBOX_KEY = "sent_mail_copy_mailbox";
export const SENT_MAIL_TARGET_SCOPE_PREFIX =
  "sent-mail:target-sha256:";

export interface SentMailImapConfiguration {
  host: string;
  port: number;
  secure: true;
  username: string;
  password: string;
  mailbox: string | null;
  provider: "gmail" | "icloud" | "custom";
  targetScope: string;
}

export type SentMailConfigurationResult =
  | { ok: true; config: SentMailImapConfiguration }
  | { ok: false; error: string };

export interface SentMailCopyRequestState {
  requested: boolean;
  targetScope: string | null;
  configurationError: string | null;
}

interface SentMailTarget {
  host: string;
  port: number;
  secure: true;
  username: string;
  mailbox: string | null;
  provider: SentMailImapConfiguration["provider"];
  targetScope: string;
}

type SentMailTargetResult =
  | { ok: true; target: SentMailTarget }
  | { ok: false; error: string };

function configuredProvider(
  host: string,
): SentMailImapConfiguration["provider"] {
  const normalized = host.toLowerCase();
  if (normalized === "imap.gmail.com") return "gmail";
  if (normalized === "imap.mail.me.com") return "icloud";
  return "custom";
}

export function sentMailCopyEnabled(value: string | null | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function validateSentMailboxName(
  value: string | null | undefined,
): string | null {
  const mailbox = value?.trim() ?? "";
  if (!mailbox) return null;
  if (mailbox.length > 255 || /[\r\n\0]/.test(mailbox)) {
    return "Sent mailbox override must be 255 characters or fewer and contain no control characters";
  }
  return null;
}

export function getSentMailTarget(
  mailboxValue: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): SentMailTargetResult {
  const host = env.SENT_MAIL_IMAP_HOST?.trim().toLowerCase() ?? "";
  const username =
    env.SENT_MAIL_IMAP_USERNAME?.trim().normalize("NFKC") ?? "";
  const portValue = env.SENT_MAIL_IMAP_PORT?.trim() || "993";
  const secureValue = env.SENT_MAIL_IMAP_SECURE?.trim().toLowerCase() || "true";
  const mailbox = mailboxValue?.trim() || null;

  const missing = [
    !host && "SENT_MAIL_IMAP_HOST",
    !username && "SENT_MAIL_IMAP_USERNAME",
  ].filter((value): value is string => Boolean(value));
  if (missing.length > 0) {
    return {
      ok: false,
      error: `Sent mailbox copy is enabled but ${missing.join(", ")} ${
        missing.length === 1 ? "is" : "are"
      } missing`,
    };
  }
  if (
    host.length > 253 ||
    /[\s/:]/.test(host) ||
    !/^[a-z0-9.-]+$/i.test(host)
  ) {
    return {
      ok: false,
      error: "SENT_MAIL_IMAP_HOST must be a hostname without a URL scheme",
    };
  }
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return {
      ok: false,
      error: "SENT_MAIL_IMAP_PORT must be an integer from 1 through 65535",
    };
  }
  if (secureValue !== "true") {
    return {
      ok: false,
      error:
        "SENT_MAIL_IMAP_SECURE must be true; plaintext and opportunistic STARTTLS are not supported",
    };
  }
  const mailboxError = validateSentMailboxName(mailbox);
  if (mailboxError) return { ok: false, error: mailboxError };

  const targetScope = `${SENT_MAIL_TARGET_SCOPE_PREFIX}${createHash("sha256")
    .update("photo-admin/sent-mail-target/v1\0")
    .update(host)
    .update("\0")
    .update(String(port))
    .update("\0tls\0")
    .update(username)
    .update("\0")
    .update(mailbox ?? "\\Sent")
    .digest("hex")}`;
  return {
    ok: true,
    target: {
      host,
      port,
      secure: true,
      username,
      mailbox,
      provider: configuredProvider(host),
      targetScope,
    },
  };
}

export function getSentMailImapConfiguration(
  mailboxValue: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): SentMailConfigurationResult {
  const target = getSentMailTarget(mailboxValue, env);
  if (!target.ok) return target;
  const password = env.SENT_MAIL_IMAP_PASSWORD ?? "";
  if (!password.trim()) {
    return {
      ok: false,
      error:
        "Sent mailbox copy is enabled but SENT_MAIL_IMAP_PASSWORD is missing",
    };
  }
  return {
    ok: true,
    config: {
      ...target.target,
      password,
    },
  };
}

export function resolveSentMailCopyRequestState(
  enabledValue: string | null | undefined,
  mailboxValue: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): SentMailCopyRequestState {
  const normalizedEnabled = enabledValue?.trim().toLowerCase() ?? "";
  if (!normalizedEnabled || normalizedEnabled === "false") {
    return {
      requested: false,
      targetScope: null,
      configurationError: null,
    };
  }
  if (normalizedEnabled !== "true") {
    return {
      requested: true,
      targetScope: null,
      configurationError:
        "Sent mailbox copy setting must be explicitly true or false",
    };
  }
  const target = getSentMailTarget(mailboxValue, env);
  if (!target.ok) {
    return {
      requested: true,
      targetScope: null,
      configurationError: target.error,
    };
  }
  const configuration = getSentMailImapConfiguration(mailboxValue, env);
  return {
    requested: true,
    targetScope: target.target.targetScope,
    configurationError: configuration.ok ? null : configuration.error,
  };
}
