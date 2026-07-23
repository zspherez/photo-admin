BEGIN;

ALTER TABLE "ContactAuditRequest"
  DROP CONSTRAINT "ContactAuditRequest_source_check",
  ADD CONSTRAINT "ContactAuditRequest_source_check"
    CHECK ("source" IN ('manual', 'monthly', 'rolling_monthly', 'legacy'));

COMMIT;
