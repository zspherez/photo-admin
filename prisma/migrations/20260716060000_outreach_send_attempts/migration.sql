BEGIN;

ALTER TABLE "ResendWebhookEvent"
  ADD COLUMN IF NOT EXISTS "recipientEmails"
  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Provider requests live on immutable attempts so retries cannot accidentally
-- rebuild a different request under the same idempotency key.
CREATE TABLE "OutreachSendAttempt" (
  "id" TEXT NOT NULL,
  "outreachId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "providerRequest" JSONB,
  "requestHash" TEXT,
  "testSend" BOOLEAN,
  "providerMessageId" TEXT,
  "firstAttemptAt" TIMESTAMP(3),
  "lastAttemptAt" TIMESTAMP(3),
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "failureDisposition" TEXT,
  "nextAttemptAt" TIMESTAMP(3),
  "acceptedAt" TIMESTAMP(3),
  "error" TEXT,
  "deliveredAt" TIMESTAMP(3),
  "firstOpenedAt" TIMESTAMP(3),
  "lastOpenedAt" TIMESTAMP(3),
  "openCount" INTEGER NOT NULL DEFAULT 0,
  "firstClickedAt" TIMESTAMP(3),
  "lastClickedAt" TIMESTAMP(3),
  "clickCount" INTEGER NOT NULL DEFAULT 0,
  "bouncedAt" TIMESTAMP(3),
  "complainedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "OutreachSendAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OutreachSendAttempt_status_check"
    CHECK ("status" IN (
      'prepared',
      'sending',
      'request_failed',
      'cancelled',
      'accepted',
      'delivery_failed',
      'manual_review',
      'legacy_unknown'
    )),
  CONSTRAINT "OutreachSendAttempt_request_pair_check"
    CHECK (("providerRequest" IS NULL) = ("requestHash" IS NULL)),
  CONSTRAINT "OutreachSendAttempt_testSend_known_request_check"
    CHECK ("providerRequest" IS NULL OR "testSend" IS NOT NULL),
  CONSTRAINT "OutreachSendAttempt_requestHash_check"
    CHECK ("requestHash" IS NULL OR "requestHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "OutreachSendAttempt_failureDisposition_check"
    CHECK (
      "failureDisposition" IS NULL
      OR "failureDisposition" IN (
        'configuration',
        'in_flight',
        'retryable',
        'permanent',
        'uncertain',
        'policy'
      )
    ),
  CONSTRAINT "OutreachSendAttempt_idempotencyKey_check"
    CHECK (char_length("idempotencyKey") BETWEEN 1 AND 256)
);

CREATE UNIQUE INDEX "OutreachSendAttempt_idempotencyKey_key"
  ON "OutreachSendAttempt"("idempotencyKey");
CREATE UNIQUE INDEX "OutreachSendAttempt_providerMessageId_key"
  ON "OutreachSendAttempt"("providerMessageId");
CREATE INDEX "OutreachSendAttempt_outreachId_createdAt_idx"
  ON "OutreachSendAttempt"("outreachId", "createdAt");
CREATE INDEX "OutreachSendAttempt_status_lastAttemptAt_idx"
  ON "OutreachSendAttempt"("status", "lastAttemptAt");
CREATE INDEX "OutreachSendAttempt_status_nextAttemptAt_idx"
  ON "OutreachSendAttempt"("status", "nextAttemptAt");

ALTER TABLE "OutreachSendAttempt"
  ADD CONSTRAINT "OutreachSendAttempt_outreachId_fkey"
  FOREIGN KEY ("outreachId") REFERENCES "Outreach"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Attachment bytes are content-addressed and shared across attempts. The
-- immutable request stores only the digest and provider metadata, avoiding a
-- base64 copy of the same rate card on every outreach.
CREATE TABLE "OutreachAttachmentBlob" (
  "sha256" TEXT NOT NULL,
  "content" BYTEA NOT NULL,
  "byteLength" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "OutreachAttachmentBlob_pkey" PRIMARY KEY ("sha256"),
  CONSTRAINT "OutreachAttachmentBlob_sha256_check"
    CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "OutreachAttachmentBlob_byteLength_check"
    CHECK ("byteLength" = octet_length("content"))
);

-- Preserve provider identity for sends created before immutable request
-- snapshots existed. These attempts remain correlatable, but a missing
-- providerRequest is intentionally not retryable.
WITH legacy_event_metadata AS (
  SELECT
    e."outreachId",
    CASE
      WHEN count(DISTINCT e."providerMessageId")
        FILTER (WHERE e."providerMessageId" IS NOT NULL) = 1
        THEN min(e."providerMessageId")
          FILTER (WHERE e."providerMessageId" IS NOT NULL)
      ELSE NULL
    END AS "providerMessageId",
    bool_or(e."type" = 'email.complained') AS "hasComplaintEvent",
    bool_or(e."type" = 'email.bounced') AS "hasBounceEvent",
    bool_or(
      e."type" IN ('email.delivered', 'email.opened', 'email.clicked')
    ) AS "hasDeliveryEvidenceEvent",
    bool_or(
      e."type" IN ('email.bounced', 'email.complained', 'email.suppressed')
    ) AS "hasDeliveryFailureEvent"
  FROM "ResendWebhookEvent" e
  WHERE e."outreachId" IS NOT NULL
  GROUP BY e."outreachId"
),
legacy_enriched AS (
  SELECT
    o.*,
    COALESCE(o."providerMessageId", metadata."providerMessageId")
      AS "effectiveProviderMessageId",
    (
      COALESCE(metadata."hasComplaintEvent", false)
      OR EXISTS (
        SELECT 1
        FROM "ResendWebhookEvent" event
        WHERE o."providerMessageId" IS NOT NULL
          AND event."providerMessageId" = o."providerMessageId"
          AND event."type" = 'email.complained'
      )
    ) AS "providerComplaintEvent",
    (
      COALESCE(metadata."hasBounceEvent", false)
      OR EXISTS (
        SELECT 1
        FROM "ResendWebhookEvent" event
        WHERE o."providerMessageId" IS NOT NULL
          AND event."providerMessageId" = o."providerMessageId"
          AND event."type" = 'email.bounced'
      )
    ) AS "providerBounceEvent",
    (
      COALESCE(metadata."hasDeliveryEvidenceEvent", false)
      OR EXISTS (
        SELECT 1
        FROM "ResendWebhookEvent" event
        WHERE o."providerMessageId" IS NOT NULL
          AND event."providerMessageId" = o."providerMessageId"
          AND event."type" IN (
            'email.delivered',
            'email.opened',
            'email.clicked'
          )
      )
    ) AS "providerDeliveryEvidenceEvent",
    (
      COALESCE(metadata."hasDeliveryFailureEvent", false)
      OR EXISTS (
        SELECT 1
        FROM "ResendWebhookEvent" event
        WHERE o."providerMessageId" IS NOT NULL
          AND event."providerMessageId" = o."providerMessageId"
          AND event."type" IN (
            'email.bounced',
            'email.complained',
            'email.suppressed'
          )
      )
    ) AS "providerDeliveryFailureEvent"
  FROM "Outreach" o
  LEFT JOIN legacy_event_metadata metadata
    ON metadata."outreachId" = o."id"
  WHERE o."attemptCount" > 0
    OR o."providerMessageId" IS NOT NULL
),
legacy_source AS (
  SELECT
    legacy_enriched.*,
    CASE
      WHEN legacy_enriched."effectiveProviderMessageId" IS NULL THEN false
      ELSE count(*) OVER (
        PARTITION BY legacy_enriched."effectiveProviderMessageId"
      ) > 1
    END AS "providerMessageIdConflict"
  FROM legacy_enriched
),
legacy AS (
  SELECT
    legacy_source.*,
    (
      legacy_source."effectiveProviderMessageId" IS NOT NULL
      AND NOT legacy_source."providerMessageIdConflict"
      AND legacy_source."status" = 'test'
      AND (
        legacy_source."sentAt" IS NOT NULL
        OR legacy_source."bouncedAt" IS NOT NULL
        OR legacy_source."complainedAt" IS NOT NULL
        OR legacy_source."providerDeliveryFailureEvent"
      )
    ) AS "providerProvenTestSend",
    (
      legacy_source."status" = 'failed'
      AND (
        legacy_source."bouncedAt" IS NOT NULL
        OR legacy_source."complainedAt" IS NOT NULL
        OR legacy_source."providerDeliveryFailureEvent"
      )
      AND (
        legacy_source."complainedAt" IS NOT NULL
        OR legacy_source."providerComplaintEvent"
        OR legacy_source."deliveredAt" IS NOT NULL
        OR legacy_source."firstOpenedAt" IS NOT NULL
        OR legacy_source."lastOpenedAt" IS NOT NULL
        OR legacy_source."openCount" > 0
        OR legacy_source."firstClickedAt" IS NOT NULL
        OR legacy_source."lastClickedAt" IS NOT NULL
        OR legacy_source."clickCount" > 0
        OR legacy_source."providerDeliveryEvidenceEvent"
      )
    ) AS "providerProvenRealFailure",
    (
      legacy_source."status" = 'failed'
      AND (
        legacy_source."bouncedAt" IS NOT NULL
        OR legacy_source."providerBounceEvent"
      )
      AND legacy_source."complainedAt" IS NULL
      AND NOT legacy_source."providerComplaintEvent"
      AND legacy_source."deliveredAt" IS NULL
      AND legacy_source."firstOpenedAt" IS NULL
      AND legacy_source."lastOpenedAt" IS NULL
      AND legacy_source."openCount" = 0
      AND legacy_source."firstClickedAt" IS NULL
      AND legacy_source."lastClickedAt" IS NULL
      AND legacy_source."clickCount" = 0
      AND NOT legacy_source."providerDeliveryEvidenceEvent"
    ) AS "ambiguousLegacyBounce",
    (
      legacy_source."effectiveProviderMessageId" IS NOT NULL
      AND NOT legacy_source."providerMessageIdConflict"
      AND legacy_source."status" = 'sent'
      AND legacy_source."sentAt" IS NOT NULL
      AND legacy_source."sentAt" > GREATEST(
        COALESCE(legacy_source."bouncedAt", '-infinity'::TIMESTAMP),
        COALESCE(legacy_source."complainedAt", '-infinity'::TIMESTAMP)
      )
    ) AS "providerProvenRealSend"
  FROM legacy_source
)
INSERT INTO "OutreachSendAttempt" (
  "id",
  "outreachId",
  "status",
  "idempotencyKey",
  "testSend",
  "providerMessageId",
  "firstAttemptAt",
  "lastAttemptAt",
  "attemptCount",
  "failureDisposition",
  "nextAttemptAt",
  "acceptedAt",
  "error",
  "deliveredAt",
  "firstOpenedAt",
  "lastOpenedAt",
  "openCount",
  "firstClickedAt",
  "lastClickedAt",
  "clickCount",
  "bouncedAt",
  "complainedAt",
  "createdAt",
  "updatedAt"
)
SELECT
  legacy."id",
  legacy."id",
  CASE
    WHEN legacy."providerMessageIdConflict" THEN 'manual_review'
    WHEN legacy."providerProvenRealSend" THEN 'accepted'
    WHEN legacy."providerProvenTestSend"
      AND (
        legacy."bouncedAt" IS NOT NULL
        OR legacy."complainedAt" IS NOT NULL
        OR legacy."providerDeliveryFailureEvent"
      )
      THEN 'delivery_failed'
    WHEN legacy."providerProvenRealFailure" THEN 'delivery_failed'
    WHEN legacy."ambiguousLegacyBounce" THEN 'legacy_unknown'
    WHEN legacy."effectiveProviderMessageId" IS NULL THEN 'manual_review'
    WHEN legacy."providerProvenTestSend" THEN 'accepted'
    ELSE 'legacy_unknown'
  END,
  legacy."idempotencyKey",
  CASE
    WHEN legacy."providerMessageIdConflict" THEN NULL
    WHEN legacy."providerProvenTestSend" THEN true
    WHEN legacy."providerProvenRealFailure"
      OR legacy."providerProvenRealSend"
      THEN false
    ELSE NULL
  END,
  CASE
    WHEN legacy."providerMessageIdConflict" THEN NULL
    ELSE legacy."effectiveProviderMessageId"
  END,
  CASE
    WHEN legacy."attemptCount" > 0
      THEN COALESCE(
        legacy."lastAttemptAt",
        legacy."sentAt",
        legacy."complainedAt",
        legacy."bouncedAt",
        legacy."createdAt"
      )
    ELSE NULL
  END,
  legacy."lastAttemptAt",
  legacy."attemptCount",
  CASE
    WHEN legacy."providerProvenTestSend"
      OR legacy."providerProvenRealFailure"
      OR legacy."providerProvenRealSend"
      THEN NULL
    ELSE 'uncertain'
  END,
  NULL,
  CASE
    WHEN legacy."providerProvenTestSend"
      OR legacy."providerProvenRealFailure"
      OR legacy."providerProvenRealSend"
      THEN COALESCE(
        legacy."sentAt",
        legacy."complainedAt",
        legacy."bouncedAt",
        legacy."lastAttemptAt",
        legacy."createdAt"
      )
    ELSE NULL
  END,
  CASE
    WHEN legacy."providerMessageIdConflict"
      THEN 'Duplicate legacy provider message ID; review correlation manually'
    WHEN legacy."providerProvenRealSend"
      THEN NULL
    WHEN legacy."providerProvenRealFailure"
      AND (
        legacy."complainedAt" IS NOT NULL
        OR legacy."providerComplaintEvent"
      )
      THEN 'complaint'
    WHEN legacy."providerProvenRealFailure"
      THEN COALESCE(legacy."error", 'bounce:legacy')
    WHEN legacy."providerProvenTestSend"
      AND legacy."complainedAt" IS NOT NULL
      THEN 'complaint'
    WHEN legacy."providerProvenTestSend"
      AND legacy."bouncedAt" IS NOT NULL
      THEN COALESCE(legacy."error", 'bounce:legacy')
    WHEN legacy."ambiguousLegacyBounce"
      THEN 'Legacy failed bounce may have been a test send; provider events are quarantined and real outreach may replace it'
    WHEN legacy."effectiveProviderMessageId" IS NULL
      THEN 'Legacy provider attempt has no immutable request snapshot; provider acceptance is uncertain; review manually'
    WHEN NOT legacy."providerProvenTestSend"
      AND NOT legacy."providerProvenRealFailure"
      AND NOT legacy."providerProvenRealSend"
      THEN 'Legacy provider attempt cannot be verified as a real or test send; provider events are quarantined and replacement requires manual review'
    ELSE legacy."error"
  END,
  legacy."deliveredAt",
  legacy."firstOpenedAt",
  legacy."lastOpenedAt",
  legacy."openCount",
  legacy."firstClickedAt",
  legacy."lastClickedAt",
  legacy."clickCount",
  legacy."bouncedAt",
  legacy."complainedAt",
  legacy."createdAt",
  CURRENT_TIMESTAMP
FROM legacy;

-- A signed outreach tag can preserve the provider message identity even when
-- an older application write missed it. Only the unique attempt identity
-- selected above is allowed to repair the current outreach pointer.
UPDATE "Outreach" o
SET "providerMessageId" = a."providerMessageId"
FROM "OutreachSendAttempt" a
WHERE a."outreachId" = o."id"
  AND a."idempotencyKey" = o."idempotencyKey"
  AND o."providerMessageId" IS NULL
  AND a."providerMessageId" IS NOT NULL;

-- Backfill address suppression only from provider-reported recipients or a
-- verified immutable recipient snapshot. Unknown legacy contact addresses are
-- never guessed, and test sends never suppress their intended recipients.
WITH failure_recipients AS (
  SELECT
    recipient."email",
    CASE
      WHEN a."complainedAt" IS NOT NULL THEN 'complaint'
      ELSE COALESCE(a."error", 'bounce:legacy')
    END AS "reason",
    NULL::TEXT AS "sourceEventId",
    COALESCE(
      a."complainedAt",
      a."bouncedAt",
      a."acceptedAt",
      a."lastAttemptAt",
      a."createdAt"
    ) AS "suppressedAt"
  FROM "OutreachSendAttempt" a
  JOIN "Outreach" o ON o."id" = a."outreachId"
  CROSS JOIN LATERAL unnest(
    CASE
      WHEN o."recipientSnapshotState" = 'verified'
        THEN o."recipientEmails"
      ELSE ARRAY[]::TEXT[]
    END
  ) AS recipient("email")
  WHERE a."testSend" = false
    AND a."status" = 'delivery_failed'
    AND (
      a."complainedAt" IS NOT NULL
      OR a."bouncedAt" IS NOT NULL
    )

  UNION ALL

  SELECT
    recipient."email",
    CASE e."type"
      WHEN 'email.complained' THEN 'complaint'
      WHEN 'email.bounced' THEN 'bounce:legacy'
      ELSE 'suppressed:provider'
    END AS "reason",
    e."eventId" AS "sourceEventId",
    e."providerCreatedAt" AS "suppressedAt"
  FROM "ResendWebhookEvent" e
  JOIN "OutreachSendAttempt" a
    ON (
      e."providerMessageId" IS NOT NULL
      AND e."providerMessageId" = a."providerMessageId"
    )
    OR (
      e."providerMessageId" IS NULL
      AND e."outreachId" = a."outreachId"
    )
  CROSS JOIN LATERAL unnest(e."recipientEmails") AS recipient("email")
  WHERE a."testSend" = false
    AND e."type" IN (
      'email.bounced',
      'email.complained',
      'email.suppressed'
    )
),
normalized_failure_recipients AS (
  SELECT
    lower(trim("email")) AS "normalizedEmail",
    "reason",
    "sourceEventId",
    "suppressedAt"
  FROM failure_recipients
  WHERE lower(trim("email")) ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
),
latest_failure_recipients AS (
  SELECT DISTINCT ON ("normalizedEmail")
    "normalizedEmail",
    "reason",
    "sourceEventId",
    "suppressedAt"
  FROM normalized_failure_recipients
  ORDER BY
    "normalizedEmail",
    "suppressedAt" DESC,
    "sourceEventId" DESC NULLS LAST
)
INSERT INTO "EmailSuppression" (
  "normalizedEmail",
  "reason",
  "source",
  "sourceEventId",
  "suppressedAt",
  "createdAt",
  "updatedAt"
)
SELECT
  "normalizedEmail",
  "reason",
  'resend',
  "sourceEventId",
  "suppressedAt",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM latest_failure_recipients
ON CONFLICT ("normalizedEmail") DO UPDATE
SET
  "reason" = EXCLUDED."reason",
  "source" = EXCLUDED."source",
  "sourceEventId" = EXCLUDED."sourceEventId",
  "suppressedAt" = EXCLUDED."suppressedAt",
  "updatedAt" = CURRENT_TIMESTAMP
WHERE EXCLUDED."suppressedAt" >= "EmailSuppression"."suppressedAt";

-- Provider IDs were not unique before immutable attempts. Preserve the legacy
-- rows, but quarantine ambiguous identities instead of failing the migration
-- or assigning a webhook to an arbitrary outreach.
WITH duplicate_message_ids AS (
  SELECT "providerMessageId"
  FROM "Outreach"
  WHERE "providerMessageId" IS NOT NULL
  GROUP BY "providerMessageId"
  HAVING count(*) > 1
)
UPDATE "Outreach" o
SET
  "status" = 'manual_review',
  "error" = 'Duplicate legacy provider message ID; review correlation manually',
  "claimedAt" = NULL,
  "claimToken" = NULL,
  "scheduledFor" = NULL
FROM duplicate_message_ids d
WHERE o."providerMessageId" = d."providerMessageId";

-- A provider ID proves acceptance, but an unverifiable legacy status cannot
-- prove whether the accepted request was a test override or real outreach.
-- Keep the immutable history quarantined; replacement requires an explicit
-- manual decision because provider acceptance is already proven.
UPDATE "Outreach" o
SET
  "status" = 'manual_review',
  "error" = COALESCE(
    a."error",
    'Legacy provider attempt cannot be verified as a real or test send; provider events are quarantined and replacement requires manual review'
  ),
  "claimedAt" = NULL,
  "claimToken" = NULL,
  "scheduledFor" = NULL
FROM "OutreachSendAttempt" a
WHERE a."outreachId" = o."id"
  AND a."idempotencyKey" = o."idempotencyKey"
  AND a."status" = 'legacy_unknown';

-- Any pre-cutover provider attempt without an exact request snapshot could
-- already have reached Resend. Quarantine every such row, regardless of its
-- old application status, rather than allowing runtime recovery to resubmit it.
UPDATE "Outreach"
SET
  "status" = 'manual_review',
  "error" = 'Legacy provider attempt has no immutable request snapshot; provider acceptance is uncertain; review manually',
  "claimedAt" = NULL,
  "claimToken" = NULL,
  "scheduledFor" = NULL
WHERE "attemptCount" > 0
  AND "providerMessageId" IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "OutreachSendAttempt" a
    WHERE a."outreachId" = "Outreach"."id"
      AND a."idempotencyKey" = "Outreach"."idempotencyKey"
      AND a."status" = 'legacy_unknown'
      AND a."error" = 'Legacy failed bounce may have been a test send; provider events are quarantined and real outreach may replace it'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "OutreachSendAttempt" a
    WHERE a."outreachId" = "Outreach"."id"
      AND a."idempotencyKey" = "Outreach"."idempotencyKey"
      AND a."status" IN ('accepted', 'delivery_failed')
  );

-- Unattempted legacy scheduled/failed work also has no trustworthy recipient
-- snapshot. It is not a duplicate risk, but it must be reviewed rather than
-- rebuilt from mutable contacts at dispatch time.
UPDATE "Outreach"
SET
  "status" = 'manual_review',
  "error" = 'Legacy outreach has no verified recipient snapshot; review recipients manually',
  "claimedAt" = NULL,
  "claimToken" = NULL,
  "scheduledFor" = NULL
WHERE "recipientSnapshotState" = 'legacy_unknown'
  AND "status" IN ('scheduled', 'queued', 'failed')
  AND NOT EXISTS (
    SELECT 1
    FROM "OutreachSendAttempt" a
    WHERE a."outreachId" = "Outreach"."id"
      AND a."idempotencyKey" = "Outreach"."idempotencyKey"
      AND a."status" IN ('accepted', 'delivery_failed')
  );

ALTER TABLE "Outreach"
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3);

UPDATE "Outreach"
SET "nextAttemptAt" = "scheduledFor"
WHERE "status" = 'scheduled'
  AND "scheduledFor" IS NOT NULL;

CREATE INDEX "Outreach_status_nextAttemptAt_idx"
  ON "Outreach"("status", "nextAttemptAt");

ALTER TABLE "ResendWebhookEvent"
  ADD COLUMN "attemptId" TEXT,
  ADD COLUMN "correlationStatus" TEXT NOT NULL DEFAULT 'unmatched',
  ADD COLUMN "correlationError" TEXT;

ALTER TABLE "ResendWebhookEvent"
  ADD CONSTRAINT "ResendWebhookEvent_correlationStatus_check"
  CHECK ("correlationStatus" IN ('matched', 'conflict', 'unmatched'));

UPDATE "ResendWebhookEvent" e
SET
  "outreachId" = CASE
    WHEN e."outreachId" IS NULL OR e."outreachId" = a."outreachId"
      THEN a."outreachId"
    ELSE e."outreachId"
  END,
  "attemptId" = CASE
    WHEN e."outreachId" IS NULL OR e."outreachId" = a."outreachId"
      THEN a."id"
    ELSE NULL
  END,
  "correlationStatus" = CASE
    WHEN e."outreachId" IS NULL OR e."outreachId" = a."outreachId"
      THEN 'matched'
    ELSE 'conflict'
  END,
  "correlationError" = CASE
    WHEN e."outreachId" IS NULL OR e."outreachId" = a."outreachId"
      THEN NULL
    ELSE 'Legacy outreach and provider message identify different attempts'
  END
FROM "OutreachSendAttempt" a
WHERE e."providerMessageId" IS NOT NULL
  AND e."providerMessageId" = a."providerMessageId";

-- Older event variants could be correlated only by their signed outreach tag.
-- At this point every legacy outreach has at most one backfilled attempt.
UPDATE "ResendWebhookEvent" e
SET
  "attemptId" = a."id",
  "correlationStatus" = 'matched',
  "correlationError" = NULL
FROM "OutreachSendAttempt" a
WHERE e."correlationStatus" = 'unmatched'
  AND e."providerMessageId" IS NULL
  AND e."outreachId" = a."outreachId";

CREATE INDEX "ResendWebhookEvent_attemptId_providerCreatedAt_idx"
  ON "ResendWebhookEvent"("attemptId", "providerCreatedAt");

ALTER TABLE "ResendWebhookEvent"
  ADD CONSTRAINT "ResendWebhookEvent_attemptId_fkey"
  FOREIGN KEY ("attemptId") REFERENCES "OutreachSendAttempt"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Request-defining fields and provider identity are write-once. Status,
-- counters, and timestamps remain mutable for retries and webhook processing.
CREATE FUNCTION "prevent_outreach_send_attempt_identity_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."outreachId" IS DISTINCT FROM OLD."outreachId"
    OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
    OR NEW."providerRequest" IS DISTINCT FROM OLD."providerRequest"
    OR NEW."requestHash" IS DISTINCT FROM OLD."requestHash"
    OR NEW."testSend" IS DISTINCT FROM OLD."testSend"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'OutreachSendAttempt request identity is immutable';
  END IF;

  IF OLD."firstAttemptAt" IS NOT NULL
    AND NEW."firstAttemptAt" IS DISTINCT FROM OLD."firstAttemptAt"
  THEN
    RAISE EXCEPTION 'OutreachSendAttempt firstAttemptAt is immutable once set';
  END IF;

  IF OLD."providerMessageId" IS NOT NULL
    AND NEW."providerMessageId" IS DISTINCT FROM OLD."providerMessageId"
  THEN
    RAISE EXCEPTION 'OutreachSendAttempt providerMessageId is immutable once set';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "OutreachSendAttempt_identity_immutable"
BEFORE UPDATE ON "OutreachSendAttempt"
FOR EACH ROW
EXECUTE FUNCTION "prevent_outreach_send_attempt_identity_mutation"();

CREATE FUNCTION "prevent_outreach_attachment_blob_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'OutreachAttachmentBlob content is immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "OutreachAttachmentBlob_immutable"
BEFORE UPDATE ON "OutreachAttachmentBlob"
FOR EACH ROW
EXECUTE FUNCTION "prevent_outreach_attachment_blob_mutation"();

COMMIT;
