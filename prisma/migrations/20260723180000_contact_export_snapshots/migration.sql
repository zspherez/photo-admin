BEGIN;

CREATE TABLE "ContactExportSnapshot" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'google_sheets',
  "status" TEXT NOT NULL DEFAULT 'pending',
  "idempotencyKey" TEXT NOT NULL,
  "contactCount" INTEGER NOT NULL,
  "contentSha256" TEXT NOT NULL,
  "spreadsheetId" TEXT NOT NULL,
  "sheetTabId" INTEGER,
  "sheetTabName" TEXT NOT NULL,
  "sheetUrl" TEXT,
  "requestedByRole" TEXT NOT NULL,
  "canonicalRows" JSONB NOT NULL,
  "error" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ContactExportSnapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ContactExportSnapshot_id_check"
    CHECK (
      "id" ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ),
  CONSTRAINT "ContactExportSnapshot_provider_check"
    CHECK ("provider" = 'google_sheets'),
  CONSTRAINT "ContactExportSnapshot_status_check"
    CHECK ("status" IN ('pending', 'writing', 'complete', 'failed')),
  CONSTRAINT "ContactExportSnapshot_idempotencyKey_check"
    CHECK (
      char_length("idempotencyKey") BETWEEN 16 AND 128
      AND "idempotencyKey" ~ '^[A-Za-z0-9._:-]+$'
    ),
  CONSTRAINT "ContactExportSnapshot_contactCount_check"
    CHECK ("contactCount" >= 0 AND "contactCount" <= 100000),
  CONSTRAINT "ContactExportSnapshot_contentSha256_check"
    CHECK (
      char_length("contentSha256") = 64
      AND "contentSha256" ~ '^[0-9a-f]+$'
    ),
  CONSTRAINT "ContactExportSnapshot_spreadsheetId_check"
    CHECK (char_length("spreadsheetId") BETWEEN 1 AND 200),
  CONSTRAINT "ContactExportSnapshot_sheetTabId_check"
    CHECK ("sheetTabId" IS NULL OR "sheetTabId" >= 0),
  CONSTRAINT "ContactExportSnapshot_sheetTabName_check"
    CHECK (char_length("sheetTabName") BETWEEN 1 AND 100),
  CONSTRAINT "ContactExportSnapshot_sheetUrl_check"
    CHECK ("sheetUrl" IS NULL OR char_length("sheetUrl") BETWEEN 1 AND 1000),
  CONSTRAINT "ContactExportSnapshot_requestedByRole_check"
    CHECK ("requestedByRole" = 'admin'),
  CONSTRAINT "ContactExportSnapshot_canonicalRows_check"
    CHECK (
      CASE
        WHEN jsonb_typeof("canonicalRows") = 'array'
        THEN jsonb_array_length("canonicalRows") = "contactCount"
        ELSE false
      END
    ),
  CONSTRAINT "ContactExportSnapshot_error_check"
    CHECK ("error" IS NULL OR char_length("error") BETWEEN 1 AND 1000),
  CONSTRAINT "ContactExportSnapshot_timestamp_order_check"
    CHECK (
      "completedAt" IS NULL OR "completedAt" >= "startedAt"
    ),
  CONSTRAINT "ContactExportSnapshot_lifecycle_check"
    CHECK (
      (
        "status" = 'pending'
        AND "sheetTabId" IS NULL
        AND "sheetUrl" IS NULL
        AND "error" IS NULL
        AND "completedAt" IS NULL
      )
      OR
      (
        "status" = 'writing'
        AND "sheetUrl" IS NULL
        AND "error" IS NULL
        AND "completedAt" IS NULL
      )
      OR
      (
        "status" = 'failed'
        AND "sheetUrl" IS NULL
        AND "error" IS NOT NULL
        AND "completedAt" IS NULL
      )
      OR
      (
        "status" = 'complete'
        AND "sheetTabId" IS NOT NULL
        AND "sheetUrl" IS NOT NULL
        AND "error" IS NULL
        AND "completedAt" IS NOT NULL
      )
    )
);

CREATE UNIQUE INDEX "ContactExportSnapshot_idempotencyKey_key"
  ON "ContactExportSnapshot"("idempotencyKey");
CREATE INDEX "ContactExportSnapshot_status_createdAt_idx"
  ON "ContactExportSnapshot"("status", "createdAt");
CREATE INDEX "ContactExportSnapshot_createdAt_idx"
  ON "ContactExportSnapshot"("createdAt");

CREATE FUNCTION "guard_contact_export_snapshot"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" = 'complete' THEN
      RAISE EXCEPTION 'Completed contact export snapshots are immutable';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."status" = 'complete' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Completed contact export snapshots are immutable';
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."provider" IS DISTINCT FROM OLD."provider"
    OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
    OR NEW."contactCount" IS DISTINCT FROM OLD."contactCount"
    OR NEW."contentSha256" IS DISTINCT FROM OLD."contentSha256"
    OR NEW."spreadsheetId" IS DISTINCT FROM OLD."spreadsheetId"
    OR NEW."sheetTabName" IS DISTINCT FROM OLD."sheetTabName"
    OR NEW."requestedByRole" IS DISTINCT FROM OLD."requestedByRole"
    OR NEW."canonicalRows" IS DISTINCT FROM OLD."canonicalRows"
    OR NEW."startedAt" IS DISTINCT FROM OLD."startedAt"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'Contact export snapshot identity and content are immutable';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'pending' AND NEW."status" IN ('writing', 'failed'))
    OR (OLD."status" = 'writing' AND NEW."status" IN ('complete', 'failed'))
    OR (OLD."status" = 'failed' AND NEW."status" = 'writing')
  ) THEN
    RAISE EXCEPTION 'Invalid contact export snapshot status transition';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "ContactExportSnapshot_guard_update"
BEFORE UPDATE ON "ContactExportSnapshot"
FOR EACH ROW
EXECUTE FUNCTION "guard_contact_export_snapshot"();

CREATE TRIGGER "ContactExportSnapshot_guard_delete"
BEFORE DELETE ON "ContactExportSnapshot"
FOR EACH ROW
EXECUTE FUNCTION "guard_contact_export_snapshot"();

COMMIT;
