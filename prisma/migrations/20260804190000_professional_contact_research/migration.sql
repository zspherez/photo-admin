BEGIN;

CREATE TABLE "ProfessionalContactRequest" (
  "id" TEXT NOT NULL,
  "requestKey" TEXT NOT NULL,
  "organizationName" TEXT NOT NULL,
  "normalizedOrganization" TEXT NOT NULL,
  "website" TEXT,
  "locationContext" TEXT,
  "notes" TEXT,
  "personNames" TEXT[] NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProfessionalContactRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProfessionalContactJob" (
  "id" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "personName" TEXT NOT NULL,
  "normalizedPersonName" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "claimedAt" TIMESTAMP(3),
  "claimExpiresAt" TIMESTAMP(3),
  "claimToken" TEXT,
  "claimProvenanceToken" TEXT,
  "resultFingerprint" TEXT,
  "agentNotes" TEXT,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProfessionalContactJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProfessionalContactJob_status_check"
    CHECK ("status" IN ('pending', 'claimed', 'review', 'exhausted', 'completed')),
  CONSTRAINT "ProfessionalContactJob_attemptCount_check"
    CHECK ("attemptCount" >= 0)
);

CREATE TABLE "ProfessionalContactDispatch" (
  "id" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "lastAttemptAt" TIMESTAMP(3),
  "lastDispatchedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProfessionalContactDispatch_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProfessionalContactDispatch_status_check"
    CHECK ("status" IN ('pending', 'dispatching', 'dispatched', 'failed')),
  CONSTRAINT "ProfessionalContactDispatch_attemptCount_check"
    CHECK ("attemptCount" >= 0)
);

CREATE TABLE "ProfessionalContactDispatchAttempt" (
  "id" TEXT NOT NULL,
  "dispatchId" TEXT NOT NULL,
  "attemptNumber" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "error" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProfessionalContactDispatchAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProfessionalContactDispatchAttempt_status_check"
    CHECK ("status" IN ('dispatching', 'succeeded', 'failed')),
  CONSTRAINT "ProfessionalContactDispatchAttempt_number_check"
    CHECK ("attemptNumber" >= 1)
);

CREATE TABLE "ProfessionalContactCandidate" (
  "id" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "normalizedEmail" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "personName" TEXT NOT NULL,
  "roleTitle" TEXT NOT NULL,
  "organization" TEXT NOT NULL,
  "confidence" TEXT NOT NULL,
  "discoveryMethod" TEXT NOT NULL,
  "evidence" TEXT NOT NULL,
  "sourceUrls" TEXT[] NOT NULL,
  "patternEvidence" TEXT,
  "patternEvidenceUrl" TEXT,
  "patternExamples" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProfessionalContactCandidate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProfessionalContactCandidate_confidence_check"
    CHECK ("confidence" IN ('high', 'medium', 'low')),
  CONSTRAINT "ProfessionalContactCandidate_discoveryMethod_check"
    CHECK ("discoveryMethod" IN ('official', 'professional_profile', 'business_directory', 'domain_pattern')),
  CONSTRAINT "ProfessionalContactCandidate_pattern_check"
    CHECK (
      ("discoveryMethod" <> 'domain_pattern' AND "patternEvidence" IS NULL AND "patternEvidenceUrl" IS NULL)
      OR
      ("discoveryMethod" = 'domain_pattern' AND "confidence" = 'low' AND "patternEvidence" IS NOT NULL AND "patternEvidenceUrl" IS NOT NULL)
    )
);

CREATE TABLE "ProfessionalContactDecision" (
  "id" TEXT NOT NULL,
  "candidateId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProfessionalContactDecision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProfessionalContactDecision_action_check"
    CHECK ("action" IN ('approved', 'rejected'))
);

CREATE TABLE "ProfessionalContactEvent" (
  "id" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "jobId" TEXT,
  "candidateId" TEXT,
  "kind" TEXT NOT NULL,
  "actor" TEXT NOT NULL,
  "details" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProfessionalContactEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProfessionalContactEvent_kind_check"
    CHECK ("kind" IN ('request_created', 'dispatch_started', 'dispatch_succeeded', 'dispatch_failed', 'job_claimed', 'result_submitted', 'job_exhausted', 'job_requeued', 'candidate_approved', 'candidate_rejected'))
);

CREATE UNIQUE INDEX "ProfessionalContactRequest_requestKey_key"
  ON "ProfessionalContactRequest"("requestKey");
CREATE INDEX "ProfessionalContactRequest_createdAt_idx"
  ON "ProfessionalContactRequest"("createdAt");
CREATE UNIQUE INDEX "ProfessionalContactJob_claimToken_key"
  ON "ProfessionalContactJob"("claimToken");
CREATE UNIQUE INDEX "ProfessionalContactJob_claimProvenanceToken_key"
  ON "ProfessionalContactJob"("claimProvenanceToken");
CREATE UNIQUE INDEX "ProfessionalContactJob_requestId_normalizedPersonName_key"
  ON "ProfessionalContactJob"("requestId", "normalizedPersonName");
CREATE INDEX "ProfessionalContactJob_status_createdAt_idx"
  ON "ProfessionalContactJob"("status", "createdAt");
CREATE INDEX "ProfessionalContactJob_status_claimExpiresAt_idx"
  ON "ProfessionalContactJob"("status", "claimExpiresAt");
CREATE UNIQUE INDEX "ProfessionalContactDispatch_requestId_key"
  ON "ProfessionalContactDispatch"("requestId");
CREATE UNIQUE INDEX "ProfessionalContactDispatch_leaseToken_key"
  ON "ProfessionalContactDispatch"("leaseToken");
CREATE INDEX "ProfessionalContactDispatch_status_updatedAt_idx"
  ON "ProfessionalContactDispatch"("status", "updatedAt");
CREATE INDEX "ProfessionalContactDispatch_leaseExpiresAt_idx"
  ON "ProfessionalContactDispatch"("leaseExpiresAt");
CREATE UNIQUE INDEX "ProfessionalContactDispatchAttempt_dispatchId_attemptNumber_key"
  ON "ProfessionalContactDispatchAttempt"("dispatchId", "attemptNumber");
CREATE INDEX "ProfessionalContactDispatchAttempt_status_startedAt_idx"
  ON "ProfessionalContactDispatchAttempt"("status", "startedAt");
CREATE UNIQUE INDEX "ProfessionalContactCandidate_jobId_normalizedEmail_key"
  ON "ProfessionalContactCandidate"("jobId", "normalizedEmail");
CREATE INDEX "ProfessionalContactCandidate_jobId_createdAt_idx"
  ON "ProfessionalContactCandidate"("jobId", "createdAt");
CREATE UNIQUE INDEX "ProfessionalContactDecision_candidateId_key"
  ON "ProfessionalContactDecision"("candidateId");
CREATE INDEX "ProfessionalContactEvent_requestId_createdAt_idx"
  ON "ProfessionalContactEvent"("requestId", "createdAt");
CREATE INDEX "ProfessionalContactEvent_jobId_createdAt_idx"
  ON "ProfessionalContactEvent"("jobId", "createdAt");
CREATE INDEX "ProfessionalContactEvent_candidateId_createdAt_idx"
  ON "ProfessionalContactEvent"("candidateId", "createdAt");

ALTER TABLE "ProfessionalContactJob"
  ADD CONSTRAINT "ProfessionalContactJob_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "ProfessionalContactRequest"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProfessionalContactDispatch"
  ADD CONSTRAINT "ProfessionalContactDispatch_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "ProfessionalContactRequest"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProfessionalContactDispatchAttempt"
  ADD CONSTRAINT "ProfessionalContactDispatchAttempt_dispatchId_fkey"
  FOREIGN KEY ("dispatchId") REFERENCES "ProfessionalContactDispatch"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProfessionalContactCandidate"
  ADD CONSTRAINT "ProfessionalContactCandidate_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "ProfessionalContactJob"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProfessionalContactDecision"
  ADD CONSTRAINT "ProfessionalContactDecision_candidateId_fkey"
  FOREIGN KEY ("candidateId") REFERENCES "ProfessionalContactCandidate"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProfessionalContactEvent"
  ADD CONSTRAINT "ProfessionalContactEvent_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "ProfessionalContactRequest"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProfessionalContactEvent"
  ADD CONSTRAINT "ProfessionalContactEvent_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "ProfessionalContactJob"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProfessionalContactEvent"
  ADD CONSTRAINT "ProfessionalContactEvent_candidateId_fkey"
  FOREIGN KEY ("candidateId") REFERENCES "ProfessionalContactCandidate"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION reject_professional_contact_request_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Professional contact request snapshots are immutable';
END;
$$;

CREATE TRIGGER "ProfessionalContactRequest_immutable_update"
BEFORE UPDATE ON "ProfessionalContactRequest"
FOR EACH ROW EXECUTE FUNCTION reject_professional_contact_request_mutation();
CREATE TRIGGER "ProfessionalContactRequest_immutable_delete"
BEFORE DELETE ON "ProfessionalContactRequest"
FOR EACH ROW EXECUTE FUNCTION reject_professional_contact_request_mutation();

CREATE FUNCTION reject_professional_contact_candidate_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Professional contact candidates are immutable';
END;
$$;

CREATE TRIGGER "ProfessionalContactCandidate_immutable_update"
BEFORE UPDATE ON "ProfessionalContactCandidate"
FOR EACH ROW EXECUTE FUNCTION reject_professional_contact_candidate_mutation();
CREATE TRIGGER "ProfessionalContactCandidate_immutable_delete"
BEFORE DELETE ON "ProfessionalContactCandidate"
FOR EACH ROW EXECUTE FUNCTION reject_professional_contact_candidate_mutation();

CREATE FUNCTION reject_professional_contact_decision_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Professional contact decisions are immutable';
END;
$$;

CREATE TRIGGER "ProfessionalContactDecision_immutable_update"
BEFORE UPDATE ON "ProfessionalContactDecision"
FOR EACH ROW EXECUTE FUNCTION reject_professional_contact_decision_mutation();
CREATE TRIGGER "ProfessionalContactDecision_immutable_delete"
BEFORE DELETE ON "ProfessionalContactDecision"
FOR EACH ROW EXECUTE FUNCTION reject_professional_contact_decision_mutation();

CREATE FUNCTION reject_professional_contact_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Professional contact audit events are immutable';
END;
$$;

CREATE TRIGGER "ProfessionalContactEvent_immutable_update"
BEFORE UPDATE ON "ProfessionalContactEvent"
FOR EACH ROW EXECUTE FUNCTION reject_professional_contact_event_mutation();
CREATE TRIGGER "ProfessionalContactEvent_immutable_delete"
BEFORE DELETE ON "ProfessionalContactEvent"
FOR EACH ROW EXECUTE FUNCTION reject_professional_contact_event_mutation();

COMMIT;
