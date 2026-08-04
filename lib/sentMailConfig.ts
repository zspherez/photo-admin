export const SENT_MAIL_COPY_ENABLED_KEY = "sent_mail_copy_enabled";
export const SENT_MAIL_COPY_MAILBOX_KEY = "sent_mail_copy_mailbox";

export interface SentMailImapConfiguration {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  mailbox: string | null;
  provider: "gmail" | "icloud" | "custom";
}

export type SentMailConfigurationResult =
  | { ok: true; config: SentMailImapConfiguration }
  | { ok: false; error: string };

export interface SentMailCopyRequestState {
  requested: boolean;
  configurationError: string | null;
}

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

export function getSentMailImapConfiguration(
  mailboxValue: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): SentMailConfigurationResult {
  const host = env.SENT_MAIL_IMAP_HOST?.trim() ?? "";
  const username = env.SENT_MAIL_IMAP_USERNAME?.trim() ?? "";
  const password = env.SENT_MAIL_IMAP_PASSWORD?.trim() ?? "";
  const portValue = env.SENT_MAIL_IMAP_PORT?.trim() || "993";
  const secureValue = env.SENT_MAIL_IMAP_SECURE?.trim().toLowerCase() || "true";
  const mailbox = mailboxValue?.trim() || null;

  const missing = [
    !host && "SENT_MAIL_IMAP_HOST",
    !username && "SENT_MAIL_IMAP_USERNAME",
    !password && "SENT_MAIL_IMAP_PASSWORD",
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
  if (secureValue !== "true" && secureValue !== "false") {
    return {
      ok: false,
      error: "SENT_MAIL_IMAP_SECURE must be true or false",
    };
  }
  const mailboxError = validateSentMailboxName(mailbox);
  if (mailboxError) return { ok: false, error: mailboxError };

  return {
    ok: true,
    config: {
      host,
      port,
      secure: secureValue === "true",
      username,
      password,
      mailbox,
      provider: configuredProvider(host),
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
    return { requested: false, configurationError: null };
  }
  if (normalizedEnabled !== "true") {
    return {
      requested: false,
      configurationError:
        "Sent mailbox copy setting must be explicitly true or false",
    };
  }
  const configuration = getSentMailImapConfiguration(mailboxValue, env);
  return configuration.ok
    ? { requested: true, configurationError: null }
    : { requested: true, configurationError: configuration.error };
}
