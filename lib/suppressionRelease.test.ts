import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { db } from "./db";
import { releaseEmailSuppression, suppressionReleaseInput } from "./suppressionRelease";

function form() {
  const data = new FormData();
  data.set("email", "Manager@Example.com");
  data.set("version", "2026-09-08T12:00:00.000Z");
  data.set("note", "  Reviewed and authorized  ");
  data.set("confirmed", "yes");
  return data;
}

test("suppression release requires an exact reviewed address and confirmation", () => {
  assert.deepEqual(suppressionReleaseInput(form()), {
    email: "manager@example.com",
    version: new Date("2026-09-08T12:00:00.000Z"),
    note: "Reviewed and authorized",
  });
  for (const [key, value] of [
    ["email", "invalid"],
    ["version", "bad date"],
    ["note", " "],
    ["note", "x".repeat(1001)],
    ["confirmed", "no"],
  ]) {
    const input = form();
    input.set(key, value);
    assert.ok("error" in suppressionReleaseInput(input), key);
  }
});

test("suppression release is authenticated, locked, version checked, and audited", () => {
  const source = readFileSync(new URL("./suppressionRelease.ts", import.meta.url), "utf8");
  const page = readFileSync(new URL("../app/settings/suppressions/page.tsx", import.meta.url), "utf8");
  assert.ok(page.indexOf("await requireServerActionAuth(PATH)") < page.indexOf("await releaseEmailSuppression(input)"));
  assert.match(source, /db\.\$transaction/);
  assert.ok(source.indexOf("await acquireOutreachRecipientPolicyLocks") < source.indexOf("await tx.emailSuppression.findUnique"));
  assert.match(source, /suppression\.updatedAt\.getTime\(\) !== input\.version\.getTime\(\)/);
  assert.ok(source.indexOf("await tx.emailSuppressionRelease.create") < source.indexOf("await tx.emailSuppression.delete"));
  assert.doesNotMatch(source, /sendOutreach|sendFollowUp|outreach\.update|webhookEvent\.delete/);
  assert.match(page, /disabled=\{access !== "admin"\}/);
  assert.match(page, /name="confirmed" value="yes" required/);
});

test("unblocking audits the prior reason and refuses a refreshed suppression", async (t) => {
  const calls: string[] = [];
  const version = new Date("2026-09-08T12:00:00.000Z");
  const row = {
    normalizedEmail: "manager@example.com",
    reason: "bounce:General",
    source: "resend",
    sourceEventId: "event-1",
    suppressedAt: version,
    updatedAt: version,
  };
  const input = { email: row.normalizedEmail, version, note: "Authorized review" };
  let current: typeof row | null = row;
  const tx = {
    $queryRaw: async () => { calls.push("lock"); return [{ locked: 1 }]; },
    emailSuppression: {
      findUnique: async () => { calls.push("read"); return current; },
      delete: async ({ where }: { where: { normalizedEmail: string } }) => {
        assert.equal(where.normalizedEmail, row.normalizedEmail);
        calls.push("delete");
        return row;
      },
    },
    emailSuppressionRelease: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        assert.equal(data.reason, row.reason);
        assert.equal(data.sourceEventId, row.sourceEventId);
        assert.equal(data.note, input.note);
        calls.push("audit");
      },
    },
  };
  const original = db.$transaction;
  Object.defineProperty(db, "$transaction", {
    configurable: true,
    writable: true,
    value: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  });
  t.after(() => Object.defineProperty(db, "$transaction", {
    configurable: true,
    writable: true,
    value: original,
  }));
  assert.deepEqual(await releaseEmailSuppression(input), { released: true });
  assert.deepEqual(calls, ["lock", "read", "audit", "delete"]);
  calls.length = 0;
  current = { ...row, updatedAt: new Date(version.getTime() + 1) };
  assert.ok("error" in await releaseEmailSuppression(input));
  assert.deepEqual(calls, ["lock", "read"]);
  calls.length = 0;
  current = null;
  assert.ok("error" in await releaseEmailSuppression(input));
  assert.deepEqual(calls, ["lock", "read"]);
});
