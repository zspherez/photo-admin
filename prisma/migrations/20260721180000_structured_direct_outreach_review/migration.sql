BEGIN;

ALTER TABLE "AgentRuleSet"
  ADD COLUMN "directOutreachRules" JSONB NOT NULL DEFAULT '[]'::JSONB,
  ADD CONSTRAINT "AgentRuleSet_directOutreachRules_array_check"
    CHECK (jsonb_typeof("directOutreachRules") = 'array');

ALTER TABLE "ContactResearchJob"
  ADD COLUMN "claimedDirectOutreachRules" JSONB,
  ADD CONSTRAINT "ContactResearchJob_claimedDirectOutreachRules_array_check"
    CHECK (
      "claimedDirectOutreachRules" IS NULL
      OR jsonb_typeof("claimedDirectOutreachRules") = 'array'
    );

CREATE TABLE "ContactResearchDirectOutreachProposal" (
  "id" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "ruleId" TEXT NOT NULL,
  "ruleVersion" INTEGER NOT NULL,
  "canonicalRule" TEXT NOT NULL,
  "normalizedManagerName" TEXT NOT NULL,
  "managerName" TEXT NOT NULL,
  "managerCompany" TEXT,
  "note" TEXT NOT NULL,
  "sourceUrls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "evidenceQuotes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "status" TEXT NOT NULL DEFAULT 'pending',
  "contactId" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ContactResearchDirectOutreachProposal_pkey"
    PRIMARY KEY ("id"),
  CONSTRAINT "ContactResearchDirectOutreachProposal_ruleId_check"
    CHECK ("ruleId" ~ '^[a-z0-9][a-z0-9_-]{1,63}$'),
  CONSTRAINT "ContactResearchDirectOutreachProposal_ruleVersion_check"
    CHECK ("ruleVersion" >= 1),
  CONSTRAINT "ContactResearchDirectOutreachProposal_canonicalRule_check"
    CHECK (
      char_length(btrim("canonicalRule")) BETWEEN 1 AND 8000
      AND "canonicalRule" LIKE 'DIRECT_OUTREACH %'
    ),
  CONSTRAINT "ContactResearchDirectOutreachProposal_manager_check"
    CHECK (
      char_length(btrim("normalizedManagerName")) BETWEEN 2 AND 200
      AND char_length(btrim("managerName")) BETWEEN 2 AND 200
      AND (
        "managerCompany" IS NULL
        OR char_length(btrim("managerCompany")) BETWEEN 1 AND 200
      )
    ),
  CONSTRAINT "ContactResearchDirectOutreachProposal_note_check"
    CHECK (char_length(btrim("note")) BETWEEN 1 AND 1000),
  CONSTRAINT "ContactResearchDirectOutreachProposal_evidence_check"
    CHECK (
      cardinality("sourceUrls") BETWEEN 1 AND 5
      AND cardinality("sourceUrls") = cardinality("evidenceQuotes")
    ),
  CONSTRAINT "ContactResearchDirectOutreachProposal_status_check"
    CHECK ("status" IN ('pending', 'approved', 'rejected')),
  CONSTRAINT "ContactResearchDirectOutreachProposal_review_check"
    CHECK (
      ("status" = 'pending' AND "reviewedAt" IS NULL AND "contactId" IS NULL)
      OR
      ("status" = 'approved' AND "reviewedAt" IS NOT NULL AND "contactId" IS NOT NULL)
      OR
      ("status" = 'rejected' AND "reviewedAt" IS NOT NULL AND "contactId" IS NULL)
    )
);

CREATE UNIQUE INDEX "ContactResearchDirectOutreachProposal_jobId_ruleId_normalizedManagerName_key"
  ON "ContactResearchDirectOutreachProposal"(
    "jobId",
    "ruleId",
    "normalizedManagerName"
  );

CREATE INDEX "ContactResearchDirectOutreachProposal_status_createdAt_idx"
  ON "ContactResearchDirectOutreachProposal"("status", "createdAt");

CREATE INDEX "ContactResearchDirectOutreachProposal_contactId_idx"
  ON "ContactResearchDirectOutreachProposal"("contactId");

ALTER TABLE "ContactResearchDirectOutreachProposal"
  ADD CONSTRAINT "ContactResearchDirectOutreachProposal_jobId_fkey"
    FOREIGN KEY ("jobId")
    REFERENCES "ContactResearchJob"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE,
  ADD CONSTRAINT "ContactResearchDirectOutreachProposal_contactId_fkey"
    FOREIGN KEY ("contactId")
    REFERENCES "Contact"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;

COMMIT;
