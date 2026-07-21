BEGIN;

ALTER TABLE "ArbitraryEmail"
  ADD COLUMN "scheduledFor" TIMESTAMP(3),
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3),
  ADD COLUMN "claimedAt" TIMESTAMP(3),
  ADD COLUMN "claimToken" TEXT,
  ADD COLUMN "lastAttemptAt" TIMESTAMP(3),
  ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
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
        "status" <> 'queued'
        AND "claimedAt" IS NULL
        AND "claimToken" IS NULL
      )
    ),
  ADD CONSTRAINT "ArbitraryEmail_attemptCount_check"
    CHECK ("attemptCount" >= 0);

CREATE UNIQUE INDEX "ArbitraryEmail_claimToken_key"
  ON "ArbitraryEmail"("claimToken");
CREATE INDEX "ArbitraryEmail_status_nextAttemptAt_idx"
  ON "ArbitraryEmail"("status", "nextAttemptAt");
CREATE INDEX "ArbitraryEmail_status_claimedAt_idx"
  ON "ArbitraryEmail"("status", "claimedAt");

COMMIT;
