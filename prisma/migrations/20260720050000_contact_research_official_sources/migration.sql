BEGIN;

ALTER TABLE "ContactResearchCandidate"
  ADD COLUMN "needsApproval" BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN "officialSourceType" TEXT,
  ADD COLUMN "officialSourceUrl" TEXT,
  ADD COLUMN "officialManagementLabel" TEXT,
  ADD COLUMN "officialSourceEvidence" TEXT;

ALTER TABLE "ContactResearchCandidate"
  ADD CONSTRAINT "ContactResearchCandidate_official_source_type_check"
  CHECK (
    "officialSourceType" IS NULL
    OR "officialSourceType" IN (
      'website',
      'instagram',
      'facebook',
      'soundcloud'
    )
  ),
  ADD CONSTRAINT "ContactResearchCandidate_official_management_label_check"
  CHECK (
    "officialManagementLabel" IS NULL
    OR "officialManagementLabel" IN ('mgmt', 'management')
  ),
  ADD CONSTRAINT "ContactResearchCandidate_official_source_complete_check"
  CHECK (
    (
      "officialSourceType" IS NULL
      AND "officialSourceUrl" IS NULL
      AND "officialManagementLabel" IS NULL
      AND "officialSourceEvidence" IS NULL
    )
    OR (
      "officialSourceType" IS NOT NULL
      AND "officialSourceUrl" IS NOT NULL
      AND "officialManagementLabel" IS NOT NULL
      AND "officialSourceEvidence" IS NOT NULL
    )
  ),
  ADD CONSTRAINT "ContactResearchCandidate_auto_approval_evidence_check"
  CHECK (
    "needsApproval" = TRUE
    OR (
      "officialSourceType" IS NOT NULL
      AND "officialSourceUrl" IS NOT NULL
      AND "officialManagementLabel" IS NOT NULL
      AND "officialSourceEvidence" IS NOT NULL
    )
  ),
  ADD CONSTRAINT "ContactResearchCandidate_official_source_url_length_check"
  CHECK (
    "officialSourceUrl" IS NULL
    OR char_length("officialSourceUrl") BETWEEN 1 AND 2048
  ),
  ADD CONSTRAINT "ContactResearchCandidate_official_source_evidence_length_check"
  CHECK (
    "officialSourceEvidence" IS NULL
    OR char_length("officialSourceEvidence") BETWEEN 1 AND 4000
  );

COMMIT;
