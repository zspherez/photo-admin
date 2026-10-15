BEGIN;

CREATE TABLE "FestivalB2b" (
    "id" TEXT NOT NULL,
    "showId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "providerManaged" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "FestivalB2b_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FestivalB2bMember" (
    "b2bId" TEXT NOT NULL,
    "artistId" TEXT NOT NULL,
    CONSTRAINT "FestivalB2bMember_pkey" PRIMARY KEY ("b2bId","artistId")
);

CREATE UNIQUE INDEX "FestivalB2b_showId_name_key" ON "FestivalB2b"("showId","name");
CREATE INDEX "FestivalB2b_showId_idx" ON "FestivalB2b"("showId");
CREATE INDEX "FestivalB2bMember_artistId_idx" ON "FestivalB2bMember"("artistId");

ALTER TABLE "FestivalB2b" ADD CONSTRAINT "FestivalB2b_showId_fkey"
    FOREIGN KEY ("showId") REFERENCES "Show"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FestivalB2bMember" ADD CONSTRAINT "FestivalB2bMember_b2bId_fkey"
    FOREIGN KEY ("b2bId") REFERENCES "FestivalB2b"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FestivalB2bMember" ADD CONSTRAINT "FestivalB2bMember_artistId_fkey"
    FOREIGN KEY ("artistId") REFERENCES "Artist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DO $$
DECLARE
    pairing RECORD;
    member_name TEXT;
    member_normalized TEXT;
    member_id TEXT;
    member_count INTEGER;
    edmtrain_match_count INTEGER;
    pairing_id TEXT;
BEGIN
    FOR pairing IN
        SELECT sa."showId", sa."providerManaged", sa."manuallyAdded", a."name"
        FROM "ShowArtist" sa
        JOIN "Show" s ON s."id" = sa."showId"
        JOIN "Artist" a ON a."id" = sa."artistId"
        WHERE s."isFestival" AND sa."rejectedAt" IS NULL
          AND a."name" ~* '\s+b2b\s+'
    LOOP
        pairing_id := 'b2b-' || md5(pairing."showId" || ':' || pairing."name");
        INSERT INTO "FestivalB2b" ("id", "showId", "name", "providerManaged")
        VALUES (pairing_id, pairing."showId", pairing."name", pairing."providerManaged")
        ON CONFLICT ("showId", "name") DO NOTHING;

        FOR member_name IN
            SELECT trim(value)
            FROM unnest(regexp_split_to_array(pairing."name", '\s+b2b\s+', 'i')) value
        LOOP
            IF member_name = '' OR member_name ~* '(^|[^[:alnum:]])b2b([^[:alnum:]]|$)' THEN
                RAISE EXCEPTION 'Invalid B2B lineup: %', pairing."name";
            END IF;
            member_normalized := trim(regexp_replace(lower(replace(member_name, '&', 'and')), '[^[:alnum:]]+', ' ', 'g'));
            SELECT count(*),
                   count(*) FILTER (WHERE "edmtrainId" IS NOT NULL),
                   COALESCE(min("id") FILTER (WHERE "edmtrainId" IS NOT NULL), min("id"))
            INTO member_count, edmtrain_match_count, member_id
            FROM "Artist"
            WHERE "normalizedName" = member_normalized OR lower("name") = lower(member_name);
            IF member_count > 1 AND edmtrain_match_count <> 1 THEN
                RAISE EXCEPTION 'Ambiguous B2B artist: %', member_name;
            END IF;
            IF member_count = 0 THEN
                member_id := 'b2b-artist-' || md5(member_normalized || ':' || random()::text);
                INSERT INTO "Artist" ("id", "name", "normalizedName", "updatedAt")
                VALUES (member_id, member_name, member_normalized, CURRENT_TIMESTAMP);
            END IF;
            INSERT INTO "ShowArtist" ("showId", "artistId", "headliner", "providerManaged", "manuallyAdded")
            VALUES (pairing."showId", member_id, false, pairing."providerManaged", pairing."manuallyAdded")
            ON CONFLICT ("showId", "artistId") DO NOTHING;
            INSERT INTO "FestivalB2bMember" ("b2bId", "artistId")
            VALUES (pairing_id, member_id)
            ON CONFLICT ("b2bId", "artistId") DO NOTHING;
        END LOOP;
        SELECT count(*) INTO member_count
        FROM "FestivalB2bMember" WHERE "b2bId" = pairing_id;
        IF member_count < 2 THEN
            RAISE EXCEPTION 'B2B lineup needs distinct artists: %', pairing."name";
        END IF;
    END LOOP;
END $$;

COMMIT;
