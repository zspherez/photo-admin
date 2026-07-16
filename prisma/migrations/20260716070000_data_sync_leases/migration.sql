BEGIN;

CREATE TABLE "IntegrationSyncLease" (
  "key" TEXT NOT NULL,
  "ownerToken" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "IntegrationSyncLease_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "IntegrationSyncLease_expiresAt_idx"
  ON "IntegrationSyncLease"("expiresAt");

CREATE TABLE "ArtistIdentityNameClaim" (
  "normalizedName" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ArtistIdentityNameClaim_pkey" PRIMARY KEY ("normalizedName")
);

INSERT INTO "ArtistIdentityNameClaim"
  ("normalizedName", "createdAt", "updatedAt")
SELECT DISTINCT "normalizedName", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Artist"
WHERE "normalizedName" <> '';

-- Name-only creators cannot participate in the application resolver directly.
-- The claim table's unique key sees concurrent committed rows even when the
-- creator's serializable snapshot is older than the resolver transaction.
CREATE FUNCTION "guard_artist_identity_write"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  claim_created BOOLEAN;
  identity_changed BOOLEAN;
BEGIN
  PERFORM pg_advisory_xact_lock(1346916180, 1095914569);

  identity_changed := TG_OP = 'INSERT';
  IF TG_OP = 'UPDATE' THEN
    identity_changed :=
      OLD."normalizedName" IS DISTINCT FROM NEW."normalizedName";
  END IF;

  IF NEW."normalizedName" <> ''
    AND identity_changed
  THEN
    claim_created := NULL;
    INSERT INTO "ArtistIdentityNameClaim"
      ("normalizedName", "createdAt", "updatedAt")
    VALUES (NEW."normalizedName", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT ("normalizedName") DO NOTHING
    RETURNING TRUE INTO claim_created;

    IF TG_OP = 'INSERT'
      AND NEW."spotifyId" IS NULL
      AND NEW."statsfmId" IS NULL
      AND NEW."edmtrainId" IS NULL
      AND COALESCE(claim_created, FALSE) = FALSE
    THEN
      RAISE EXCEPTION
        'Artist identity changed while creating %', NEW."name"
        USING ERRCODE = '40001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "Artist_guard_name_only_insert"
BEFORE INSERT ON "Artist"
FOR EACH ROW
EXECUTE FUNCTION "guard_artist_identity_write"();

CREATE TRIGGER "Artist_guard_identity_update"
BEFORE UPDATE OF "normalizedName", "spotifyId", "statsfmId", "edmtrainId"
ON "Artist"
FOR EACH ROW
EXECUTE FUNCTION "guard_artist_identity_write"();

CREATE FUNCTION "cleanup_artist_identity_name_claim"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(1346916180, 1095914569);

  IF OLD."normalizedName" <> ''
    AND NOT EXISTS (
      SELECT 1
      FROM "Artist"
      WHERE "normalizedName" = OLD."normalizedName"
    )
  THEN
    DELETE FROM "ArtistIdentityNameClaim"
    WHERE "normalizedName" = OLD."normalizedName";
  END IF;

  RETURN NULL;
END;
$$;

CREATE TRIGGER "Artist_cleanup_normalized_name_update"
AFTER UPDATE OF "normalizedName" ON "Artist"
FOR EACH ROW
WHEN (OLD."normalizedName" IS DISTINCT FROM NEW."normalizedName")
EXECUTE FUNCTION "cleanup_artist_identity_name_claim"();

CREATE TRIGGER "Artist_cleanup_name_claim_delete"
AFTER DELETE ON "Artist"
FOR EACH ROW
EXECUTE FUNCTION "cleanup_artist_identity_name_claim"();

COMMIT;
