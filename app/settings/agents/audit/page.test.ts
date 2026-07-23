import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const form = readFileSync(
  new URL("./audit-agent-rules-form.tsx", import.meta.url),
  "utf8",
);
const actions = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");
const audit = readFileSync(
  new URL("../../../../lib/contactAudit.ts", import.meta.url),
  "utf8",
);
const migration = readFileSync(
  new URL(
    "../../../../prisma/migrations/20260723210000_contact_audit_agent_rules/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

test("audit rules pane is authenticated, versioned, and structured", () => {
  assert.match(page, /Contact audit agent rules/);
  assert.match(form, /Auto-add confirmed additional manager contacts/);
  assert.match(form, /Save audit rules/);
  assert.match(actions, /requireServerActionAuth\("\/settings\/agents\/audit"\)/);
  assert.match(actions, /saveContactAuditAgentRules/);
});

test("audit claims snapshot instructions and auto-append policy", () => {
  assert.match(audit, /claimedAgentRules: auditAgentRules\.instructions/);
  assert.match(
    audit,
    /claimedAutoAppendAdditionalContact:[\s\S]*auditAgentRules\.autoAppendAdditionalContact/,
  );
  assert.match(audit, /auditAgentRules: \{/);
  assert.match(audit, /contactAuditAutoAppendAlternativeId/);
  assert.match(audit, /action: "append"/);
});

test("the requested safe coexisting-contact policy is enabled by default", () => {
  assert.match(migration, /DROP CONSTRAINT "AgentRuleSet_scope_check"/);
  assert.match(
    migration,
    /CHECK \("scope" IN \('global', 'contact_audit'\)\)/,
  );
  assert.match(migration, /ADD COLUMN "claimedAgentRules"/);
  assert.match(migration, /claimedAutoAppendAdditionalContact/);
  assert.match(migration, /auto_append_additional_contact/);
  assert.match(migration, /Do not mark an existing contact stale without direct evidence/);
});
