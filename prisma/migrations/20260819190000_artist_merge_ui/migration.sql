BEGIN;

CREATE TABLE "ArtistExternalIdentityAlias" (
  "id" TEXT NOT NULL,
  "artistId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "externalId" TEXT NOT NULL,
  "sourceArtistId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ArtistExternalIdentityAlias_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ArtistExternalIdentityAlias_artistId_fkey"
    FOREIGN KEY ("artistId") REFERENCES "Artist"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ArtistExternalIdentityAlias_provider_check"
    CHECK ("provider" IN ('spotify', 'statsfm', 'edmtrain')),
  CONSTRAINT "ArtistExternalIdentityAlias_externalId_check"
    CHECK (btrim("externalId") <> ''),
  CONSTRAINT "ArtistExternalIdentityAlias_sourceArtistId_check"
    CHECK (btrim("sourceArtistId") <> '')
);

CREATE UNIQUE INDEX "ArtistExternalIdentityAlias_provider_externalId_key"
ON "ArtistExternalIdentityAlias"("provider", "externalId");

CREATE INDEX "ArtistExternalIdentityAlias_artistId_idx"
ON "ArtistExternalIdentityAlias"("artistId");

CREATE INDEX "ArtistExternalIdentityAlias_sourceArtistId_idx"
ON "ArtistExternalIdentityAlias"("sourceArtistId");

CREATE TABLE "ArtistMergeEvent" (
  "id" TEXT NOT NULL,
  "sourceArtistId" TEXT NOT NULL,
  "sourceName" TEXT NOT NULL,
  "targetArtistId" TEXT NOT NULL,
  "targetName" TEXT NOT NULL,
  "sourceSnapshot" JSONB NOT NULL,
  "mergeSummary" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ArtistMergeEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ArtistMergeEvent_sourceArtistId_check"
    CHECK (btrim("sourceArtistId") <> ''),
  CONSTRAINT "ArtistMergeEvent_targetArtistId_check"
    CHECK (btrim("targetArtistId") <> ''),
  CONSTRAINT "ArtistMergeEvent_distinct_artists_check"
    CHECK ("sourceArtistId" <> "targetArtistId")
);

CREATE INDEX "ArtistMergeEvent_targetArtistId_createdAt_idx"
ON "ArtistMergeEvent"("targetArtistId", "createdAt");

CREATE INDEX "ArtistMergeEvent_sourceArtistId_idx"
ON "ArtistMergeEvent"("sourceArtistId");

CREATE FUNCTION reject_artist_merge_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Artist merge audit events are immutable';
END;
$$;

CREATE TRIGGER "ArtistMergeEvent_immutable_update"
BEFORE UPDATE ON "ArtistMergeEvent"
FOR EACH ROW EXECUTE FUNCTION reject_artist_merge_event_mutation();

CREATE TRIGGER "ArtistMergeEvent_immutable_delete"
BEFORE DELETE ON "ArtistMergeEvent"
FOR EACH ROW EXECUTE FUNCTION reject_artist_merge_event_mutation();

COMMIT;
