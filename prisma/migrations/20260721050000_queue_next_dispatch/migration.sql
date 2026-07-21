BEGIN;

ALTER TABLE "Outreach"
  ADD COLUMN "expectedRecipientContactId" TEXT,
  ADD COLUMN "expectedRecipientArtistId" TEXT,
  ADD COLUMN "expectedRecipientEmail" TEXT,
  ADD COLUMN "expectedRecipientUpdatedAt" TIMESTAMP(3);

ALTER TABLE "Outreach"
  ADD CONSTRAINT "Outreach_expected_recipient_identity_check"
    CHECK (
      (
        "expectedRecipientContactId" IS NULL
        AND "expectedRecipientArtistId" IS NULL
        AND "expectedRecipientEmail" IS NULL
        AND "expectedRecipientUpdatedAt" IS NULL
      )
      OR
      (
        "expectedRecipientContactId" IS NOT NULL
        AND "expectedRecipientArtistId" IS NOT NULL
        AND "expectedRecipientEmail" IS NOT NULL
        AND btrim("expectedRecipientEmail") <> ''
        AND "expectedRecipientUpdatedAt" IS NOT NULL
      )
    );

ALTER TABLE "ArbitraryEmail"
  ADD COLUMN "scheduledFor" TIMESTAMP(3),
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3),
  ADD COLUMN "claimedAt" TIMESTAMP(3),
  ADD COLUMN "claimToken" TEXT,
  ADD COLUMN "lastAttemptAt" TIMESTAMP(3),
  ADD COLUMN "firstAttemptAt" TIMESTAMP(3),
  ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "failureDisposition" TEXT,
  ADD COLUMN "providerCredentialScope" TEXT,
  ALTER COLUMN "providerRequest" DROP NOT NULL,
  ALTER COLUMN "requestHash" DROP NOT NULL,
  ALTER COLUMN "testSend" DROP DEFAULT,
  ALTER COLUMN "testSend" DROP NOT NULL;

ALTER TABLE "ArbitraryEmail"
  DROP CONSTRAINT "ArbitraryEmail_status_check",
  ADD CONSTRAINT "ArbitraryEmail_status_check"
    CHECK (
      "status" IN (
        'scheduled',
        'queued',
        'retry_scheduled',
        'sending',
        'sent',
        'test',
        'failed',
        'manual_review',
        'cancelled'
      )
    ),
  ADD CONSTRAINT "ArbitraryEmail_provider_snapshot_check"
    CHECK (
      (
        "providerRequest" IS NULL
        AND "requestHash" IS NULL
        AND "testSend" IS NULL
      )
      OR
      (
        "providerRequest" IS NOT NULL
        AND "requestHash" IS NOT NULL
        AND "testSend" IS NOT NULL
      )
    ),
  ADD CONSTRAINT "ArbitraryEmail_schedule_state_check"
    CHECK (
      "status" NOT IN ('scheduled', 'queued', 'retry_scheduled')
      OR ("scheduledFor" IS NOT NULL AND "nextAttemptAt" IS NOT NULL)
    ),
  ADD CONSTRAINT "ArbitraryEmail_claim_state_check"
    CHECK (
      (
        "status" = 'queued'
        AND "claimedAt" IS NOT NULL
        AND "claimToken" IS NOT NULL
      )
      OR
      (
        "status" = 'sending'
        AND (
          (
            "claimedAt" IS NULL
            AND "claimToken" IS NULL
          )
          OR
          (
            "claimedAt" IS NOT NULL
            AND "claimToken" IS NOT NULL
          )
        )
      )
      OR
      (
        "status" NOT IN ('queued', 'sending')
        AND "claimedAt" IS NULL
        AND "claimToken" IS NULL
      )
    ),
  ADD CONSTRAINT "ArbitraryEmail_attemptCount_check"
    CHECK ("attemptCount" >= 0),
  ADD CONSTRAINT "ArbitraryEmail_attempt_timing_check"
    CHECK (
      (
        "attemptCount" = 0
        AND "firstAttemptAt" IS NULL
      )
      OR
      (
        "attemptCount" > 0
        AND "firstAttemptAt" IS NOT NULL
        AND "providerCredentialScope" IS NOT NULL
      )
    ),
  ADD CONSTRAINT "ArbitraryEmail_failureDisposition_check"
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
  ADD CONSTRAINT "ArbitraryEmail_providerCredentialScope_check"
    CHECK (
      "providerCredentialScope" IS NULL
      OR btrim("providerCredentialScope") <> ''
    );

CREATE OR REPLACE FUNCTION "protect_arbitrary_email_dispatch_scope"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."providerCredentialScope" IS NOT NULL
     AND NEW."providerCredentialScope" IS DISTINCT FROM OLD."providerCredentialScope" THEN
    RAISE EXCEPTION 'ArbitraryEmail providerCredentialScope is immutable once set';
  END IF;
  IF OLD."firstAttemptAt" IS NOT NULL
     AND NEW."firstAttemptAt" IS DISTINCT FROM OLD."firstAttemptAt" THEN
    RAISE EXCEPTION 'ArbitraryEmail firstAttemptAt is immutable once set';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ArbitraryEmail_queue_dispatch_snapshots_immutable"
BEFORE UPDATE ON "ArbitraryEmail"
FOR EACH ROW
EXECUTE FUNCTION "protect_arbitrary_email_dispatch_scope"();

CREATE UNIQUE INDEX "ArbitraryEmail_claimToken_key"
  ON "ArbitraryEmail"("claimToken");
CREATE INDEX "ArbitraryEmail_status_nextAttemptAt_idx"
  ON "ArbitraryEmail"("status", "nextAttemptAt");
CREATE INDEX "ArbitraryEmail_status_claimedAt_idx"
  ON "ArbitraryEmail"("status", "claimedAt");

COMMIT;
