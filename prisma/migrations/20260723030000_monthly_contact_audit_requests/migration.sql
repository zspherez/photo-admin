BEGIN;

ALTER TABLE "ContactAuditRequest"
  ADD COLUMN "requestKey" TEXT,
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual',
  ADD CONSTRAINT "ContactAuditRequest_source_check"
    CHECK ("source" IN ('manual', 'monthly', 'legacy'));

UPDATE "ContactAuditRequest"
SET "source" = 'legacy'
WHERE "id" LIKE 'legacy-%';

DROP INDEX "ContactAuditRequest_one_active_key";

CREATE UNIQUE INDEX "ContactAuditRequest_requestKey_key"
  ON "ContactAuditRequest"("requestKey");
CREATE UNIQUE INDEX "ContactAuditRequest_one_running_key"
  ON "ContactAuditRequest" ((1))
  WHERE "status" = 'running';

CREATE OR REPLACE FUNCTION "enforce_contact_audit_request_transition"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."requestedAt" IS DISTINCT FROM OLD."requestedAt" THEN
    RAISE EXCEPTION 'Contact audit request time is immutable';
  END IF;

  IF NEW."requestKey" IS DISTINCT FROM OLD."requestKey"
     OR NEW."source" IS DISTINCT FROM OLD."source" THEN
    RAISE EXCEPTION 'Contact audit request identity is immutable';
  END IF;

  IF OLD."runId" IS NOT NULL AND NEW."runId" IS DISTINCT FROM OLD."runId" THEN
    RAISE EXCEPTION 'Contact audit request run link is immutable';
  END IF;

  IF OLD."status" IN ('completed', 'failed') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Terminal contact audit requests are immutable';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'pending' AND NEW."status" IN ('running', 'completed', 'failed')) OR
    (OLD."status" = 'running' AND NEW."status" IN ('pending', 'completed', 'failed'))
  ) THEN
    RAISE EXCEPTION 'Invalid contact audit request status transition';
  END IF;

  RETURN NEW;
END;
$$;

COMMIT;
