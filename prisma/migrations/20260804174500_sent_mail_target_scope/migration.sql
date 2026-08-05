BEGIN;

ALTER TABLE "OutreachSendAttempt"
  ADD COLUMN "sentMailboxTargetScope" TEXT,
  ADD COLUMN "sentMailboxCopyConfigurationError" TEXT;

ALTER TABLE "ArbitraryEmail"
  ADD COLUMN "sentMailboxTargetScope" TEXT,
  ADD COLUMN "sentMailboxCopyConfigurationError" TEXT;

ALTER TABLE "SentMailCopy"
  ADD COLUMN "targetScope" TEXT;

UPDATE "SentMailCopy"
SET
  "status" = 'manual_review',
  "error" = COALESCE(
    "error",
    'Sent copy predates immutable mailbox target binding; review before retrying'
  ),
  "nextAttemptAt" = CURRENT_TIMESTAMP,
  "claimedAt" = NULL,
  "claimToken" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "targetScope" IS NULL
  AND "status" <> 'copied';

ALTER TABLE "OutreachSendAttempt"
  ADD CONSTRAINT "OutreachSendAttempt_sentMailboxTargetScope_format_check"
  CHECK (
    "sentMailboxTargetScope" IS NULL
    OR "sentMailboxTargetScope"
      ~ '^sent-mail:target-sha256:[0-9a-f]{64}$'
  );

ALTER TABLE "ArbitraryEmail"
  ADD CONSTRAINT "ArbitraryEmail_sentMailboxTargetScope_format_check"
  CHECK (
    "sentMailboxTargetScope" IS NULL
    OR "sentMailboxTargetScope"
      ~ '^sent-mail:target-sha256:[0-9a-f]{64}$'
  );

ALTER TABLE "SentMailCopy"
  ADD CONSTRAINT "SentMailCopy_targetScope_format_check"
  CHECK (
    "targetScope" IS NULL
    OR "targetScope" ~ '^sent-mail:target-sha256:[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT "SentMailCopy_targetScope_status_check"
  CHECK (
    "targetScope" IS NOT NULL
    OR "status" IN ('manual_review', 'copied')
  );

CREATE FUNCTION "normalize_unbound_sent_mail_copy"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."targetScope" IS NULL AND NEW."status" <> 'copied' THEN
    NEW."status" := 'manual_review';
    NEW."error" := COALESCE(
      NEW."error",
      'Sent copy has no immutable mailbox target; review before retrying'
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SentMailCopy_normalize_unbound_insert"
BEFORE INSERT ON "SentMailCopy"
FOR EACH ROW
EXECUTE FUNCTION "normalize_unbound_sent_mail_copy"();

CREATE OR REPLACE FUNCTION "prevent_sent_mail_copy_identity_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."outreachAttemptId" IS DISTINCT FROM OLD."outreachAttemptId"
    OR NEW."arbitraryEmailId" IS DISTINCT FROM OLD."arbitraryEmailId"
    OR NEW."providerMessageId" IS DISTINCT FROM OLD."providerMessageId"
    OR NEW."targetScope" IS DISTINCT FROM OLD."targetScope"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'SentMailCopy source identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

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
    OR NEW."sentMailboxTargetScope" IS DISTINCT FROM OLD."sentMailboxTargetScope"
    OR NEW."sentMailboxCopyConfigurationError"
      IS DISTINCT FROM OLD."sentMailboxCopyConfigurationError"
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
     AND (
       NEW."sentMailboxCopyRequested" IS DISTINCT FROM OLD."sentMailboxCopyRequested"
       OR NEW."sentMailboxTargetScope" IS DISTINCT FROM OLD."sentMailboxTargetScope"
       OR NEW."sentMailboxCopyConfigurationError"
         IS DISTINCT FROM OLD."sentMailboxCopyConfigurationError"
     ) THEN
    RAISE EXCEPTION 'ArbitraryEmail Sent mailbox copy identity is immutable once set';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
