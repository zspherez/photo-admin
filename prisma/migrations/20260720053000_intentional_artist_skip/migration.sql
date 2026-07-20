BEGIN;

ALTER TABLE "ContactResearchJob"
  DROP CONSTRAINT "ContactResearchJob_status_check",
  ADD CONSTRAINT "ContactResearchJob_status_check"
    CHECK ("status" IN (
      'pending',
      'claimed',
      'review',
      'complete',
      'exhausted',
      'inactive',
      'skipped'
    ));

CREATE TABLE "ArtistResearchSkip" (
  "id" TEXT NOT NULL,
  "artistId" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "sourceJobId" TEXT,
  "agentRuleVersion" INTEGER,
  "agentRuleText" TEXT,
  "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "clearedAt" TIMESTAMP(3),
  "clearedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ArtistResearchSkip_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ArtistResearchSkip_source_check"
    CHECK ("source" IN ('manual', 'agent')),
  CONSTRAINT "ArtistResearchSkip_reason_check"
    CHECK (
      char_length(btrim("reason")) BETWEEN 1 AND 4000
    ),
  CONSTRAINT "ArtistResearchSkip_agent_provenance_check"
    CHECK (
      (
        "source" = 'manual'
        AND "sourceJobId" IS NULL
        AND "agentRuleVersion" IS NULL
        AND "agentRuleText" IS NULL
      )
      OR
      (
        "source" = 'agent'
        AND "sourceJobId" IS NOT NULL
        AND "agentRuleVersion" >= 1
        AND char_length(btrim("agentRuleText")) BETWEEN 1 AND 8000
      )
    ),
  CONSTRAINT "ArtistResearchSkip_clear_audit_check"
    CHECK (
      ("clearedAt" IS NULL AND "clearedBy" IS NULL)
      OR
      (
        "clearedAt" IS NOT NULL
        AND "clearedBy" = 'manual'
        AND "clearedAt" >= "setAt"
      )
    )
);

CREATE UNIQUE INDEX "ArtistResearchSkip_active_artist_key"
  ON "ArtistResearchSkip"("artistId")
  WHERE "clearedAt" IS NULL;
CREATE INDEX "ArtistResearchSkip_artistId_clearedAt_idx"
  ON "ArtistResearchSkip"("artistId", "clearedAt");
CREATE INDEX "ArtistResearchSkip_sourceJobId_idx"
  ON "ArtistResearchSkip"("sourceJobId");

ALTER TABLE "ArtistResearchSkip"
  ADD CONSTRAINT "ArtistResearchSkip_artistId_fkey"
  FOREIGN KEY ("artistId") REFERENCES "Artist"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ArtistResearchSkip"
  ADD CONSTRAINT "ArtistResearchSkip_sourceJobId_fkey"
  FOREIGN KEY ("sourceJobId") REFERENCES "ContactResearchJob"("id")
  ON DELETE NO ACTION ON UPDATE CASCADE;

COMMIT;
