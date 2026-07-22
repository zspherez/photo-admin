BEGIN;

ALTER TABLE "ContactResearchCandidate"
  DROP CONSTRAINT "ContactResearchCandidate_status_check",
  ADD CONSTRAINT "ContactResearchCandidate_status_check"
    CHECK (
      "status" IN (
        'pending',
        'approved',
        'rejected',
        'superseded'
      )
    );

COMMIT;
