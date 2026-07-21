BEGIN;

ALTER TABLE "Contact"
  ADD COLUMN "directOutreachIdentity" TEXT,
  ADD COLUMN "directOutreachSourceJobId" TEXT,
  ADD COLUMN "directOutreachRuleVersion" INTEGER,
  ADD COLUMN "directOutreachRuleText" TEXT,
  ADD COLUMN "directOutreachManagerName" TEXT,
  ADD COLUMN "directOutreachManagerCompany" TEXT,
  ADD COLUMN "directOutreachEvidenceUrls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "directOutreachEvidence" TEXT;

CREATE UNIQUE INDEX "Contact_directOutreachIdentity_key"
  ON "Contact"("directOutreachIdentity");

ALTER TABLE "Contact"
  ADD CONSTRAINT "Contact_agent_direct_outreach_provenance_check"
  CHECK (
    (
      "directOutreachIdentity" IS NULL
      AND "directOutreachSourceJobId" IS NULL
      AND "directOutreachRuleVersion" IS NULL
      AND "directOutreachRuleText" IS NULL
      AND "directOutreachManagerName" IS NULL
      AND "directOutreachManagerCompany" IS NULL
      AND cardinality("directOutreachEvidenceUrls") = 0
      AND "directOutreachEvidence" IS NULL
    )
    OR
    (
      "directOutreachIdentity" ~ '^[0-9a-f]{64}$'
      AND "directOutreachNote" IS NOT NULL
      AND char_length(btrim("directOutreachNote")) BETWEEN 1 AND 1000
      AND "directOutreachSourceJobId" IS NOT NULL
      AND char_length(btrim("directOutreachSourceJobId")) > 0
      AND "directOutreachRuleVersion" IS NOT NULL
      AND "directOutreachRuleVersion" >= 1
      AND "directOutreachRuleText" IS NOT NULL
      AND char_length(btrim("directOutreachRuleText")) BETWEEN 1 AND 8000
      AND "directOutreachManagerName" IS NOT NULL
      AND char_length(btrim("directOutreachManagerName")) BETWEEN 1 AND 200
      AND (
        "directOutreachManagerCompany" IS NULL
        OR char_length(btrim("directOutreachManagerCompany")) BETWEEN 1 AND 200
      )
      AND cardinality("directOutreachEvidenceUrls") BETWEEN 1 AND 5
      AND "directOutreachEvidence" IS NOT NULL
      AND char_length(btrim("directOutreachEvidence")) BETWEEN 1 AND 4000
    )
  ) NOT VALID;

ALTER TABLE "Contact"
  VALIDATE CONSTRAINT "Contact_agent_direct_outreach_provenance_check";

COMMIT;
