import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import {
  arbitraryEmailEventUpdate,
  arbitraryEmailWebhookConflict,
  parseArbitraryEmailInput,
} from "./arbitraryEmail";

test("arbitrary email input validates recipients and adds explicit UTM values", () => {
  const result = parseArbitraryEmailInput({
    recipients: " One@Example.com, two@example.com;one@example.com ",
    subject: " Gallery update ",
    html: '<p><a href="https://example.com/work?view=all#new">View</a></p>',
    utm_source: "newsletter",
    utm_medium: "email",
    utm_campaign: "summer",
    utm_content: "hero",
    utm_term: "portraits",
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.input.recipientEmails, [
    "one@example.com",
    "two@example.com",
  ]);
  assert.equal(result.input.subject, "Gallery update");
  assert.match(
    result.input.html,
    /view=all&amp;utm_source=newsletter&amp;utm_medium=email&amp;utm_campaign=summer&amp;utm_content=hero&amp;utm_term=portraits#new/,
  );
  const unsafeScheme = parseArbitraryEmailInput({
    recipients: "one@example.com",
    subject: "Safe link",
    html: '<a href="javascript:alert(1)">Do not rewrite</a>',
    utm_source: "newsletter",
  });
  assert.equal(unsafeScheme.ok, true);
  if (unsafeScheme.ok) {
    assert.match(unsafeScheme.input.html, /href="javascript:alert\(1\)"/);
  }
});

test("arbitrary email input rejects invalid recipients and header injection", () => {
  assert.deepEqual(
    parseArbitraryEmailInput({
      recipients: "valid@example.com, invalid",
      subject: "Subject",
      html: "<p>Hello</p>",
    }),
    { ok: false, error: "One or more recipient email addresses are invalid" },
  );
  assert.deepEqual(
    parseArbitraryEmailInput({
      recipients: "valid@example.com",
      subject: "Subject\r\nBcc: hidden@example.com",
      html: "<p>Hello</p>",
    }),
    { ok: false, error: "Subject is invalid or too long" },
  );
});

test("arbitrary email event updates count engagement and preserve event bounds", () => {
  const first = new Date("2026-07-20T12:00:00Z");
  const later = new Date("2026-07-20T13:00:00Z");
  const state = {
    status: "sent",
    testSend: false,
    sentAt: first,
    deliveredAt: null,
    firstOpenedAt: later,
    lastOpenedAt: later,
    openCount: 1,
    firstClickedAt: null,
    lastClickedAt: null,
    clickCount: 0,
    bouncedAt: null,
    complainedAt: null,
  };

  assert.deepEqual(arbitraryEmailEventUpdate(state, "email.opened", first), {
    firstOpenedAt: first,
    lastOpenedAt: later,
    openCount: { increment: 1 },
  });
  assert.deepEqual(arbitraryEmailEventUpdate(state, "email.clicked", later), {
    firstClickedAt: later,
    lastClickedAt: later,
    clickCount: { increment: 1 },
  });
});

test("late provider acceptance does not erase a terminal delivery failure", () => {
  const occurredAt = new Date("2026-07-20T14:00:00Z");
  const state = {
    status: "failed",
    testSend: false,
    sentAt: null,
    deliveredAt: null,
    firstOpenedAt: null,
    lastOpenedAt: null,
    openCount: 0,
    firstClickedAt: null,
    lastClickedAt: null,
    clickCount: 0,
    bouncedAt: occurredAt,
    complainedAt: null,
  };

  assert.deepEqual(arbitraryEmailEventUpdate(state, "email.sent", occurredAt), {
    status: "failed",
    sentAt: occurredAt,
  });
  assert.deepEqual(
    arbitraryEmailEventUpdate(state, "email.delivery_delayed", occurredAt),
    {},
  );
  assert.deepEqual(
    arbitraryEmailEventUpdate(state, "email.failed", occurredAt),
    {},
  );
  assert.deepEqual(
    arbitraryEmailEventUpdate(state, "email.suppressed", occurredAt),
    {},
  );
});

test("arbitrary webhook correlation rejects outreach and provider identity conflicts", () => {
  const arbitrary = { id: "arbitrary-1", providerMessageId: null };
  assert.equal(
    arbitraryEmailWebhookConflict(
      {
        arbitraryEmailId: arbitrary.id,
        outreachId: null,
        attemptId: null,
        providerMessageId: "message-1",
      },
      arbitrary,
      null,
      null,
    ),
    null,
  );
  assert.match(
    arbitraryEmailWebhookConflict(
      {
        arbitraryEmailId: arbitrary.id,
        outreachId: "outreach-1",
        attemptId: null,
        providerMessageId: "message-1",
      },
      arbitrary,
      null,
      null,
    ) ?? "",
    /conflicts with outreach identity/,
  );
  assert.match(
    arbitraryEmailWebhookConflict(
      {
        arbitraryEmailId: arbitrary.id,
        outreachId: null,
        attemptId: null,
        providerMessageId: "message-1",
      },
      arbitrary,
      null,
      { id: "attempt-1" },
    ) ?? "",
    /belongs to an outreach attempt/,
  );
  assert.match(
    arbitraryEmailWebhookConflict(
      {
        arbitraryEmailId: "missing-arbitrary",
        outreachId: null,
        attemptId: null,
        providerMessageId: "message-1",
      },
      null,
      arbitrary,
      null,
    ) ?? "",
    /tagged arbitrary email not found/,
  );
  assert.match(
    arbitraryEmailWebhookConflict(
      {
        arbitraryEmailId: arbitrary.id,
        outreachId: null,
        attemptId: null,
        providerMessageId: "message-2",
      },
      { ...arbitrary, providerMessageId: "message-1" },
      null,
      null,
    ) ?? "",
    /conflicts with arbitrary email/,
  );
});

test("arbitrary email migration is ordered, transactional, and constrained", () => {
  const migrationsDirectory = new URL("../prisma/migrations/", import.meta.url);
  const migrationNames = readdirSync(migrationsDirectory, {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const migrationName = "20260720190000_arbitrary_emails";
  assert.equal(migrationNames.at(-1), migrationName);

  const migration = readFileSync(
    new URL(`${migrationName}/migration.sql`, migrationsDirectory),
    "utf8",
  );
  assert.match(migration, /^BEGIN;\n/);
  assert.match(migration, /\nCOMMIT;\s*$/);
  assert.match(migration, /CONSTRAINT "ArbitraryEmail_status_check"/);
  assert.match(migration, /CONSTRAINT "ArbitraryEmail_requestHash_check"/);
  assert.match(migration, /CONSTRAINT "ArbitraryEmail_recipientEmails_check"/);
  assert.match(
    migration,
    /FOREIGN KEY \("arbitraryEmailId"\) REFERENCES "ArbitraryEmail"\("id"\)/,
  );
});
