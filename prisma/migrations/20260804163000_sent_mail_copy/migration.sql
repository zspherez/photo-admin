BEGIN;

ALTER TABLE "OutreachSendAttempt"
  ADD COLUMN "sentMailboxCopyRequested" BOOLEAN;

ALTER TABLE "ArbitraryEmail"
  ADD COLUMN "sentMailboxCopyRequested" BOOLEAN;

CREATE TABLE "SentMailCopy" (
  "id" TEXT NOT NULL,
  "outreachAttemptId" TEXT,
  "arbitraryEmailId" TEXT,
  "providerMessageId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimedAt" TIMESTAMP(3),
  "claimToken" TEXT,
  "mailbox" TEXT,
  "mailboxUid" TEXT,
  "mailboxUidValidity" TEXT,
  "error" TEXT,
  "copiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SentMailCopy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SentMailCopy_source_check" CHECK (
    ("outreachAttemptId" IS NOT NULL)::INTEGER
      + ("arbitraryEmailId" IS NOT NULL)::INTEGER = 1
  ),
  CONSTRAINT "SentMailCopy_status_check" CHECK (
    "status" IN ('pending', 'copying', 'retry_scheduled', 'copied', 'manual_review')
  ),
  CONSTRAINT "SentMailCopy_attemptCount_check" CHECK ("attemptCount" >= 0)
);

CREATE UNIQUE INDEX "SentMailCopy_outreachAttemptId_key"
  ON "SentMailCopy"("outreachAttemptId");
CREATE UNIQUE INDEX "SentMailCopy_arbitraryEmailId_key"
  ON "SentMailCopy"("arbitraryEmailId");
CREATE UNIQUE INDEX "SentMailCopy_providerMessageId_key"
  ON "SentMailCopy"("providerMessageId");
CREATE UNIQUE INDEX "SentMailCopy_claimToken_key"
  ON "SentMailCopy"("claimToken");
CREATE INDEX "SentMailCopy_status_nextAttemptAt_idx"
  ON "SentMailCopy"("status", "nextAttemptAt");
CREATE INDEX "SentMailCopy_status_claimedAt_idx"
  ON "SentMailCopy"("status", "claimedAt");

ALTER TABLE "SentMailCopy"
  ADD CONSTRAINT "SentMailCopy_outreachAttemptId_fkey"
  FOREIGN KEY ("outreachAttemptId") REFERENCES "OutreachSendAttempt"("id")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "SentMailCopy_arbitraryEmailId_fkey"
  FOREIGN KEY ("arbitraryEmailId") REFERENCES "ArbitraryEmail"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE FUNCTION "prevent_sent_mail_copy_identity_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."outreachAttemptId" IS DISTINCT FROM OLD."outreachAttemptId"
    OR NEW."arbitraryEmailId" IS DISTINCT FROM OLD."arbitraryEmailId"
    OR NEW."providerMessageId" IS DISTINCT FROM OLD."providerMessageId"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'SentMailCopy source identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SentMailCopy_identity_immutable"
BEFORE UPDATE ON "SentMailCopy"
FOR EACH ROW
EXECUTE FUNCTION "prevent_sent_mail_copy_identity_mutation"();

CREATE OR REPLACE FUNCTION "prevent_outreach_send_attempt_identity_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."outreachId" IS DISTINCT FROM OLD."outreachId"
    OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
    OR NEW."providerRequest" IS DISTINCT FROM OLD."providerRequest"
    OR NEW."requestHash" IS DISTINCT FROM OLD."requestHash"
    OR NEW."testSend" IS DISTINCT FROM OLD."testSend"
    OR NEW."sentMailboxCopyRequested" IS DISTINCT FROM OLD."sentMailboxCopyRequested"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'OutreachSendAttempt request identity is immutable';
  END IF;

  IF OLD."providerCredentialScope" IS NOT NULL
    AND NEW."providerCredentialScope"
      IS DISTINCT FROM OLD."providerCredentialScope"
  THEN
    RAISE EXCEPTION 'OutreachSendAttempt providerCredentialScope is immutable once set';
  END IF;

  IF OLD."firstAttemptAt" IS NOT NULL
    AND NEW."firstAttemptAt" IS DISTINCT FROM OLD."firstAttemptAt"
  THEN
    RAISE EXCEPTION 'OutreachSendAttempt firstAttemptAt is immutable once set';
  END IF;

  IF NULLIF(btrim(OLD."providerMessageId"), '') IS NOT NULL
    AND NEW."providerMessageId" IS DISTINCT FROM OLD."providerMessageId"
  THEN
    RAISE EXCEPTION 'OutreachSendAttempt providerMessageId is immutable once set';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

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
  IF OLD."sentMailboxCopyRequested" IS NOT NULL
     AND NEW."sentMailboxCopyRequested" IS DISTINCT FROM OLD."sentMailboxCopyRequested" THEN
    RAISE EXCEPTION 'ArbitraryEmail sentMailboxCopyRequested is immutable once set';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
