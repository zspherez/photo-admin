BEGIN;

CREATE TABLE "ArbitraryEmail" (
  "id" TEXT NOT NULL,
  "recipientEmails" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "subject" TEXT NOT NULL,
  "html" TEXT NOT NULL,
  "utmSource" TEXT,
  "utmMedium" TEXT,
  "utmCampaign" TEXT,
  "utmContent" TEXT,
  "utmTerm" TEXT,
  "status" TEXT NOT NULL,
  "error" TEXT,
  "providerMessageId" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "providerRequest" JSONB NOT NULL,
  "requestHash" TEXT NOT NULL,
  "testSend" BOOLEAN NOT NULL DEFAULT false,
  "sentAt" TIMESTAMP(3),
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

  CONSTRAINT "ArbitraryEmail_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ArbitraryEmail_status_check"
    CHECK ("status" IN ('sending', 'sent', 'test', 'failed', 'manual_review')),
  CONSTRAINT "ArbitraryEmail_requestHash_check"
    CHECK ("requestHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ArbitraryEmail_idempotencyKey_check"
    CHECK (char_length("idempotencyKey") BETWEEN 1 AND 256),
  CONSTRAINT "ArbitraryEmail_recipientEmails_check"
    CHECK (cardinality("recipientEmails") BETWEEN 1 AND 50)
);

CREATE UNIQUE INDEX "ArbitraryEmail_providerMessageId_key"
  ON "ArbitraryEmail"("providerMessageId");
CREATE UNIQUE INDEX "ArbitraryEmail_idempotencyKey_key"
  ON "ArbitraryEmail"("idempotencyKey");
CREATE INDEX "ArbitraryEmail_createdAt_idx"
  ON "ArbitraryEmail"("createdAt");
CREATE INDEX "ArbitraryEmail_status_createdAt_idx"
  ON "ArbitraryEmail"("status", "createdAt");

ALTER TABLE "ResendWebhookEvent"
  ADD COLUMN "arbitraryEmailId" TEXT;

CREATE INDEX "ResendWebhookEvent_arbitraryEmailId_providerCreatedAt_idx"
  ON "ResendWebhookEvent"("arbitraryEmailId", "providerCreatedAt");

ALTER TABLE "ResendWebhookEvent"
  ADD CONSTRAINT "ResendWebhookEvent_arbitraryEmailId_fkey"
  FOREIGN KEY ("arbitraryEmailId") REFERENCES "ArbitraryEmail"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
