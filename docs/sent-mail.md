# Sent mailbox copy

Photo Admin sends through Resend, so Resend acceptance does not automatically
create a message in Gmail, iCloud Mail, or another mailbox's Sent folder. BCC
also does not create a Sent item.

This integration appends a MIME copy of every newly accepted **real** message
to the account's actual IMAP Sent mailbox. It covers normal, festival,
follow-up, scheduled, and arbitrary/custom email paths. Test-mode sends are
excluded.

## Configure

Set these server-only environment variables:

```text
SENT_MAIL_IMAP_HOST=
SENT_MAIL_IMAP_PORT=993
SENT_MAIL_IMAP_SECURE=true
SENT_MAIL_IMAP_USERNAME=
SENT_MAIL_IMAP_PASSWORD=
```

`SENT_MAIL_IMAP_SECURE` must be `true`. Photo Admin supports implicit TLS only;
it rejects plaintext and opportunistic STARTTLS configurations rather than
risking downgrade or credential exposure.

Then open **Settings → Sent mailbox copy**, optionally enter a mailbox override,
and enable the integration. Enabling fails closed when required configuration
is missing or malformed.

The default behavior discovers the mailbox advertised with the standard IMAP
`\Sent` attribute. Use an override only when the provider does not advertise
one or the account needs an explicit mapping.

### Gmail

- Host: `imap.gmail.com`
- Port/TLS: `993` / `true`
- Username: full Gmail or Google Workspace address
- Password: a Google app password; the primary account password is not
  accepted
- Typical override if discovery is unavailable: `[Gmail]/Sent Mail`

### iCloud Mail

- Host: `imap.mail.me.com`
- Port/TLS: `993` / `true`
- Username: Apple documents the local part first; use the full iCloud address
  if required by the account
- Password: an Apple app-specific password
- Typical override if discovery is unavailable: `Sent Messages`

Apple's current server settings are documented at
<https://support.apple.com/en-us/102525>.

## Reliability and privacy

Provider acceptance and mailbox append are separate operations. Missing,
invalid, unavailable, or mismatched IMAP configuration never blocks the Resend
submission. Photo Admin durably records the Sent-copy failure after Resend
acceptance, retries it independently, and never resubmits the outbound email to
repair a mailbox copy.
After the bounded automatic retry limit, Settings shows a manual-review count
and provides a safe retry action.

Every stored copy receives a deterministic internal header. Before each IMAP
`APPEND`, the worker searches the Sent mailbox for that header. This makes
recovery idempotent even if the connection drops after the server stores the
message but before acknowledging the append.

At acceptance, Photo Admin also stores an immutable non-secret SHA-256 target
scope derived from the normalized IMAP host, username, port/TLS mode, and
mailbox mapping. Password rotation does not change the scope. Account, host, or
mailbox changes do; pending copies remain visibly retryable and are never
redirected to the new target.

When Resend conclusively rejects a request without accepting it, a later retry
refreshes the target from the then-current locked settings. Once provider
acceptance is possible or confirmed, the prior target remains immutable.

The scheduled-outreach endpoint always drains outbound work first. Sent-copy
work uses only the remaining route deadline, does not start an IMAP attempt
without a safe time budget, and closes timed-out connections early enough to
release the durable claim before the route exits.

The IMAP password remains in server-side environment configuration. Message
content and credentials are not written to application logs.
