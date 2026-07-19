BEGIN;

-- Stats.fm artist 24118 is Taylor Swift. Stats.fm currently returns three
-- Spotify IDs for this record; only the canonical artist profile is valid.
DO $$
DECLARE
  statsfm_artist_id TEXT;
  canonical_artist_id TEXT;
BEGIN
  SELECT "id"
  INTO statsfm_artist_id
  FROM "Artist"
  WHERE "statsfmId" = '24118';

  IF statsfm_artist_id IS NULL THEN
    RETURN;
  END IF;

  SELECT "id"
  INTO canonical_artist_id
  FROM "Artist"
  WHERE "spotifyId" = '06HL4z0CvFAxyc27GXpf02';

  IF canonical_artist_id IS NOT NULL
    AND canonical_artist_id <> statsfm_artist_id THEN
    RAISE EXCEPTION
      'Taylor Swift identity is split across Artist rows; explicit relation merge required';
  END IF;

  UPDATE "Artist"
  SET
    "spotifyId" = '06HL4z0CvFAxyc27GXpf02',
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = statsfm_artist_id
    AND (
      "spotifyId" IS NULL
      OR "spotifyId" IN (
        '0EnfKiZg4Bgj8TN6RZvKpR',
        '7nehoivkuzx1IsSPZTlm7w'
      )
    );
END
$$;

COMMIT;
