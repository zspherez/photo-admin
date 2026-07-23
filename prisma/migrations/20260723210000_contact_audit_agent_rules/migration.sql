BEGIN;

ALTER TABLE "AgentRuleSet"
  DROP CONSTRAINT "AgentRuleSet_scope_check",
  ADD CONSTRAINT "AgentRuleSet_scope_check"
    CHECK ("scope" IN ('global', 'contact_audit'));

ALTER TABLE "ContactAuditJob"
  ADD COLUMN "claimedAgentRules" TEXT,
  ADD COLUMN "claimedAgentRulesVersion" INTEGER,
  ADD COLUMN "claimedAutoAppendAdditionalContact" BOOLEAN,
  ADD CONSTRAINT "ContactAuditJob_claimedAgentRules_length_check"
    CHECK (
      "claimedAgentRules" IS NULL
      OR char_length("claimedAgentRules") <= 8000
    ),
  ADD CONSTRAINT "ContactAuditJob_claimedAgentRulesVersion_check"
    CHECK (
      "claimedAgentRulesVersion" IS NULL
      OR "claimedAgentRulesVersion" >= 0
    );

INSERT INTO "AgentRuleSet" (
  "scope",
  "instructions",
  "directOutreachRules",
  "version",
  "createdAt",
  "updatedAt"
)
VALUES (
  'contact_audit',
  'When a high-confidence additional management email is found and every existing roster contact is current or coexisting, propose it as an additional contact. Do not mark an existing contact stale without direct evidence.',
  '[{"action":"auto_append_additional_contact","enabled":true}]'::jsonb,
  1,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("scope") DO NOTHING;

COMMIT;
