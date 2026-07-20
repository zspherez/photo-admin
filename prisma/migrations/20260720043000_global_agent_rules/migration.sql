BEGIN;

CREATE TABLE "AgentRuleSet" (
  "scope" TEXT NOT NULL,
  "instructions" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AgentRuleSet_pkey" PRIMARY KEY ("scope"),
  CONSTRAINT "AgentRuleSet_scope_check" CHECK ("scope" = 'global'),
  CONSTRAINT "AgentRuleSet_instructions_length_check"
    CHECK (char_length("instructions") <= 8000),
  CONSTRAINT "AgentRuleSet_version_check" CHECK ("version" >= 1)
);

ALTER TABLE "ContactResearchJob"
  ADD COLUMN "claimedAgentRules" TEXT,
  ADD COLUMN "claimedAgentRulesVersion" INTEGER,
  ADD CONSTRAINT "ContactResearchJob_claimedAgentRules_length_check"
    CHECK (
      "claimedAgentRules" IS NULL
      OR char_length("claimedAgentRules") <= 8000
    ),
  ADD CONSTRAINT "ContactResearchJob_claimedAgentRulesVersion_check"
    CHECK (
      "claimedAgentRulesVersion" IS NULL
      OR "claimedAgentRulesVersion" >= 0
    );

COMMIT;
