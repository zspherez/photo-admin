BEGIN;

ALTER TABLE "ContactAuditArtistDecision"
  DROP CONSTRAINT "ContactAuditArtistDecision_createdContactId_fkey";

ALTER TABLE "ContactAuditDecisionContact"
  DROP CONSTRAINT "ContactAuditDecisionContact_contactId_fkey";

COMMIT;
