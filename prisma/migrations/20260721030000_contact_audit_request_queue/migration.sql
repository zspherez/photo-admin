BEGIN;

CREATE TABLE "ContactAuditRequest" (
  "id" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "runId" TEXT,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "lastAttemptAt" TIMESTAMP(3),
  "lastWorkflowRunId" TEXT,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ContactAuditRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ContactAuditRequest_status_check"
    CHECK ("status" IN ('pending', 'running', 'completed', 'failed')),
  CONSTRAINT "ContactAuditRequest_attemptCount_check"
    CHECK ("attemptCount" >= 0),
  CONSTRAINT "ContactAuditRequest_workflowRunId_check"
    CHECK (
      "lastWorkflowRunId" IS NULL OR
      "lastWorkflowRunId" ~ '^[1-9][0-9]{0,19}$'
    ),
  CONSTRAINT "ContactAuditRequest_lastError_check"
    CHECK ("lastError" IS NULL OR char_length("lastError") BETWEEN 1 AND 4000),
  CONSTRAINT "ContactAuditRequest_timestamp_order_check"
    CHECK (
      ("startedAt" IS NULL OR "startedAt" >= "requestedAt") AND
      ("completedAt" IS NULL OR "completedAt" >= "requestedAt") AND
      ("lastAttemptAt" IS NULL OR "lastAttemptAt" >= "requestedAt")
    ),
  CONSTRAINT "ContactAuditRequest_lifecycle_check"
    CHECK (
      (
        "status" = 'pending'
        AND "completedAt" IS NULL
      )
      OR
      (
        "status" = 'running'
        AND "startedAt" IS NOT NULL
        AND "completedAt" IS NULL
        AND "runId" IS NOT NULL
      )
      OR
      (
        "status" = 'completed'
        AND "startedAt" IS NOT NULL
        AND "completedAt" IS NOT NULL
        AND "runId" IS NOT NULL
        AND "lastError" IS NULL
      )
      OR
      (
        "status" = 'failed'
        AND "completedAt" IS NOT NULL
        AND "lastError" IS NOT NULL
      )
    )
);

CREATE UNIQUE INDEX "ContactAuditRequest_runId_key"
  ON "ContactAuditRequest"("runId");

INSERT INTO "ContactAuditRequest" (
  "id",
  "status",
  "requestedAt",
  "startedAt",
  "runId",
  "attemptCount",
  "createdAt",
  "updatedAt"
)
SELECT
  'legacy-' || running."id",
  'running',
  running."createdAt",
  running."createdAt",
  running."id",
  0,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "ContactAuditRun" running
WHERE running."status" = 'running'
ORDER BY running."createdAt" ASC, running."id" ASC
LIMIT 1;

CREATE UNIQUE INDEX "ContactAuditRequest_one_active_key"
  ON "ContactAuditRequest" ((1))
  WHERE "status" IN ('pending', 'running');
CREATE INDEX "ContactAuditRequest_status_requestedAt_idx"
  ON "ContactAuditRequest"("status", "requestedAt");
CREATE INDEX "ContactAuditRequest_requestedAt_idx"
  ON "ContactAuditRequest"("requestedAt");

ALTER TABLE "ContactAuditRequest"
  ADD CONSTRAINT "ContactAuditRequest_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "ContactAuditRun"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "enforce_contact_audit_request_transition"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."requestedAt" IS DISTINCT FROM OLD."requestedAt" THEN
    RAISE EXCEPTION 'Contact audit request time is immutable';
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

CREATE TRIGGER "ContactAuditRequest_transition_guard"
BEFORE UPDATE ON "ContactAuditRequest"
FOR EACH ROW
EXECUTE FUNCTION "enforce_contact_audit_request_transition"();

COMMIT;
