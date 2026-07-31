import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

function source(file: string): string {
  return readFileSync(path.join(process.cwd(), file), "utf8");
}

test("outreach and custom history share one Emails section header", () => {
  const header = source("components/email-center-header.tsx");
  const outreach = source("app/outreach/page.tsx");
  const custom = source("app/emails/page.tsx");

  assert.match(header, /aria-label="Email sections"/);
  assert.match(header, /href: "\/outreach", label: "Outreach"/);
  assert.match(header, /href: "\/emails", label: "Custom emails"/);
  assert.match(header, /href="\/emails\/new"/);
  assert.match(outreach, /<EmailCenterHeader active="outreach" \/>/);
  assert.match(custom, /<EmailCenterHeader active="custom" \/>/);
});

test("Emails navigation defaults to outreach history", () => {
  const nav = source("components/nav.tsx");
  assert.match(nav, /href: "\/outreach",\s+label: "Emails"/);
  assert.doesNotMatch(nav, /href: "\/emails",\s+label: "Emails"/);
});

test("existing outreach URLs and filter forms remain stable", () => {
  const outreach = source("app/outreach/page.tsx");

  assert.match(outreach, /return query \? `\/outreach\?\$\{query\}` : "\/outreach"/);
  assert.match(outreach, /action="\/outreach"/);
});

test("outreach history has recoverable bulk dismissal and restore", () => {
  const outreach = source("app/outreach/page.tsx");
  const actions = source("app/outreach/actions.ts");
  assert.match(outreach, /OutreachView = "active" \| "dismissed"/);
  assert.match(outreach, /EmailBulkSelection/);
  assert.match(outreach, /name="emailIds"/);
  assert.match(outreach, /Dismissed \{dismissedCount\}/);
  assert.match(actions, /updateOutreachEmailVisibilityAction/);
  assert.match(actions, /data: \{\s*dismissedAt:/);
  assert.match(actions, /sanitizeNextPath\(formData\.get\("returnTo"\)\)/);
  assert.match(actions, /destination\.searchParams\.set\(resultKey/);
  assert.match(outreach, /returnTo=\{returnTo\}/);
  assert.doesNotMatch(actions, /outreach\.delete/);
  const migration = source(
    "prisma/migrations/20260729113000_outreach_email_dismissal/migration.sql",
  );
  assert.match(migration, /^BEGIN;\n/);
  assert.match(migration, /ADD COLUMN "dismissedAt" TIMESTAMP\(3\)/);
  assert.match(migration, /Outreach_dismissedAt_createdAt_idx/);
  assert.match(migration, /\nCOMMIT;\s*$/);
});

test("outreach sent date and follow-up controls stay right aligned", () => {
  const outreach = source("app/outreach/page.tsx");
  assert.match(
    outreach,
    /className="flex min-w-0 flex-1 flex-wrap items-start justify-between gap-2"/,
  );
  assert.match(
    outreach,
    /className="ml-auto flex shrink-0 flex-col items-end gap-1\.5"/,
  );
});

test("outreach email center shows a recent click stream without client metadata", () => {
  const outreach = source("app/outreach/page.tsx");
  const webhook = source("app/api/resend/webhook/route.ts");
  const migration = source(
    "prisma/migrations/20260731155000_outreach_click_stream/migration.sql",
  );
  assert.match(outreach, /Recent link clicks/);
  assert.match(outreach, /type: "email\.clicked"/);
  assert.match(outreach, /correlationStatus: "matched"/);
  assert.match(outreach, /outreachClickLabel/);
  assert.match(outreach, /providerCreatedAt\.toLocaleString/);
  assert.match(webhook, /resendClickMetadata/);
  assert.doesNotMatch(webhook, /ipAddress|userAgent/);
  assert.match(migration, /^BEGIN;\n/);
  assert.match(migration, /ADD COLUMN "clickedLink" TEXT/);
  assert.match(migration, /ResendWebhookEvent_click_metadata_check/);
  assert.match(migration, /email\.clicked/);
  assert.match(migration, /"clickedLink" IS NOT NULL/);
  assert.match(migration, /\nCOMMIT;\s*$/);
});
