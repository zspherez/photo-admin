import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import {
  arbitraryEmailEventUpdate,
  arbitraryEmailWebhookConflict,
  arbitraryEmailWebhookRecipientImpact,
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
  assert.ok(result.input.html.startsWith("<!doctype html>"));
  assert.match(
    result.input.text,
    /View \(https:\/\/example\.com\/work\?view=all&utm_source=newsletter/,
  );
  const unsafeScheme = parseArbitraryEmailInput({
    recipients: "one@example.com",
    subject: "Safe link",
    html: '<a href="javascript:alert(1)">Do not rewrite</a>',
    utm_source: "newsletter",
  });
  assert.equal(unsafeScheme.ok, true);
  if (unsafeScheme.ok) {
    assert.doesNotMatch(unsafeScheme.input.html, /javascript:/);
    assert.match(unsafeScheme.input.html, /<a>Do not rewrite<\/a>/);
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
    status: "sent",
    sentAt: first,
    deliveredAt: first,
    error: null,
    firstOpenedAt: first,
    lastOpenedAt: later,
    openCount: { increment: 1 },
  });
  assert.deepEqual(arbitraryEmailEventUpdate(state, "email.clicked", later), {
    status: "sent",
    sentAt: first,
    deliveredAt: later,
    error: null,
    firstClickedAt: later,
    lastClickedAt: later,
    clickCount: { increment: 1 },
  });
});

test("arbitrary webhook recipient impact excludes neutral and audit recipients", () => {
  const intended = ["first@example.com", "second@example.com"];
  for (const type of ["email.opened", "email.bounced"]) {
    assert.deepEqual(
      arbitraryEmailWebhookRecipientImpact(intended, {
        to: ["sender@example.com"],
      }),
      {
        impactedRecipients: ["sender@example.com"],
        affectsAggregate: false,
      },
      `${type} from the neutral To address must not affect aggregates`,
    );
    assert.deepEqual(
      arbitraryEmailWebhookRecipientImpact(intended, {
        to: ["sender@example.com"],
        bcc: ["audit@example.com"],
      }),
      {
        impactedRecipients: ["audit@example.com", "sender@example.com"],
        affectsAggregate: false,
      },
      `${type} from audit BCC must not affect aggregates`,
    );
  }
});

test("arbitrary webhook recipient impact accepts intended BCC and mixed events", () => {
  const intended = ["first@example.com", "second@example.com"];
  assert.deepEqual(
    arbitraryEmailWebhookRecipientImpact(intended, {
      to: ["sender@example.com"],
      bcc: ["SECOND@example.com"],
    }),
    {
      impactedRecipients: ["second@example.com", "sender@example.com"],
      affectsAggregate: true,
    },
  );
  assert.deepEqual(
    arbitraryEmailWebhookRecipientImpact(intended, {
      to: ["sender@example.com"],
      cc: ["audit@example.com"],
      bcc: ["first@example.com", "audit@example.com"],
    }),
    {
      impactedRecipients: [
        "audit@example.com",
        "first@example.com",
        "sender@example.com",
      ],
      affectsAggregate: true,
    },
  );
});

test("arbitrary webhook recipient impact fails closed without usable metadata", () => {
  assert.deepEqual(
    arbitraryEmailWebhookRecipientImpact(["first@example.com"], {}),
    { impactedRecipients: [], affectsAggregate: false },
  );
  assert.deepEqual(
    arbitraryEmailWebhookRecipientImpact(["first@example.com"], {
      to: "first@example.com",
      bcc: [null, 42],
    }),
    { impactedRecipients: [], affectsAggregate: false },
  );
});

test("engagement reconciles uncertain real and test sends before acceptance events", () => {
  const occurredAt = new Date("2026-07-20T14:00:00Z");
  const uncertain = {
    status: "manual_review",
    testSend: false,
    sentAt: null,
    deliveredAt: null,
    firstOpenedAt: null,
    lastOpenedAt: null,
    openCount: 0,
    firstClickedAt: null,
    lastClickedAt: null,
    clickCount: 0,
    bouncedAt: null,
    complainedAt: null,
  };
  assert.deepEqual(arbitraryEmailEventUpdate(uncertain, "email.opened", occurredAt), {
    status: "sent",
    sentAt: occurredAt,
    deliveredAt: occurredAt,
    error: null,
    firstOpenedAt: occurredAt,
    lastOpenedAt: occurredAt,
    openCount: { increment: 1 },
  });
  assert.deepEqual(
    arbitraryEmailEventUpdate(
      { ...uncertain, testSend: true },
      "email.clicked",
      occurredAt,
    ),
    {
      status: "test",
      sentAt: occurredAt,
      deliveredAt: occurredAt,
      error: null,
      firstClickedAt: occurredAt,
      lastClickedAt: occurredAt,
      clickCount: { increment: 1 },
    },
  );
});

test("out-of-order acceptance events preserve earliest delivery bounds", () => {
  const openedAt = new Date("2026-07-20T14:00:00Z");
  const sentAt = new Date("2026-07-20T13:00:00Z");
  const reconciled = {
    status: "sent",
    testSend: false,
    sentAt: openedAt,
    deliveredAt: openedAt,
    firstOpenedAt: openedAt,
    lastOpenedAt: openedAt,
    openCount: 1,
    firstClickedAt: null,
    lastClickedAt: null,
    clickCount: 0,
    bouncedAt: null,
    complainedAt: null,
  };

  assert.deepEqual(arbitraryEmailEventUpdate(reconciled, "email.sent", sentAt), {
    status: "sent",
    sentAt,
    error: null,
  });
  assert.deepEqual(
    arbitraryEmailEventUpdate(reconciled, "email.delivered", sentAt),
    {
      status: "sent",
      sentAt,
      deliveredAt: sentAt,
      error: null,
    },
  );
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
  assert.deepEqual(arbitraryEmailEventUpdate(state, "email.opened", occurredAt), {
    firstOpenedAt: occurredAt,
    lastOpenedAt: occurredAt,
    openCount: { increment: 1 },
  });
});

test("duplicate arbitrary webhooks are recorded before aggregate mutation", () => {
  const route = readFileSync(
    new URL("../app/api/resend/webhook/route.ts", import.meta.url),
    "utf8",
  );
  const arbitraryBranch = route.slice(
    route.indexOf("if (arbitraryEmailId || messageArbitraryEmail)"),
    route.indexOf("const [", route.indexOf("if (arbitraryEmailId || messageArbitraryEmail)") + 1),
  );
  assert.ok(
    arbitraryBranch.indexOf("resendWebhookEvent.create") <
      arbitraryBranch.indexOf("const update = arbitraryEmailEventUpdate"),
  );
  assert.match(
    arbitraryBranch,
    /applySuppression\([\s\S]*impactedRecipients[\s\S]*if \(intendedRecipientImpact\.affectsAggregate\)/,
  );
  assert.match(
    route,
    /error\.code === "P2002"[\s\S]*resendWebhookEvent\.findUnique[\s\S]*duplicate event/,
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

test("arbitrary email migrations are ordered, transactional, and constrained", () => {
  const migrationsDirectory = new URL("../prisma/migrations/", import.meta.url);
  const migrationNames = readdirSync(migrationsDirectory, {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const migrationName = "20260720190000_arbitrary_emails";
  assert.ok(
    migrationNames.indexOf("20260720170000_festival_lead_time") <
      migrationNames.indexOf(migrationName),
  );
  const textMigrationName = "20260721003000_arbitrary_email_text";
  for (const laterMigration of [
    "20260721030000_contact_audit_request_queue",
    "20260721030000_festival_email_template",
  ]) {
    assert.ok(
      migrationNames.indexOf(textMigrationName) <
        migrationNames.indexOf(laterMigration),
    );
  }

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

  const textMigration = readFileSync(
    new URL(`${textMigrationName}/migration.sql`, migrationsDirectory),
    "utf8",
  );
  assert.match(textMigration, /^BEGIN;\n/);
  assert.match(textMigration, /\nCOMMIT;\s*$/);
  assert.match(textMigration, /ADD COLUMN "text" TEXT/);
  assert.match(textMigration, /CONSTRAINT "ArbitraryEmail_text_check"/);
  assert.match(textMigration, /"text" IS NULL OR btrim\("text"\) <> ''/);
});

test("arbitrary email UI normalizes previews and explains deliverability limits", () => {
  const editor = readFileSync(
    new URL("../components/template-editor.tsx", import.meta.url),
    "utf8",
  );
  const compose = readFileSync(
    new URL("../app/emails/new/page.tsx", import.meta.url),
    "utf8",
  );
  const dashboard = readFileSync(
    new URL("../app/emails/page.tsx", import.meta.url),
    "utf8",
  );

  assert.match(editor, /normalizeArbitraryEmailPreviewAction\(html, utm\)/);
  assert.match(compose, /previewNormalization="arbitrary-email"/);
  assert.match(compose, /avoids malformed MIME\/HTML/);
  assert.match(compose, /DNS authentication/);
  assert.match(compose, /quoted-printable message source/);
  assert.match(dashboard, /text: true/);
  assert.match(dashboard, /Canonical HTML source/);
});
