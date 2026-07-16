BEGIN;

CREATE TYPE "ContactState" AS ENUM ('active', 'quarantined');

ALTER TABLE "Contact"
  ADD COLUMN "state" "ContactState" NOT NULL DEFAULT 'active';

-- Existing contacts deliberately remain active during the expand phase so the
-- old production revision stays safe if promotion has not happened. After the
-- exact target is promoted, its Sheet reconciliation atomically adopts matches
-- and quarantines only unresolved legacy ownership while production is paused.

COMMENT ON COLUMN "Contact"."state" IS
  'active contacts are selectable/sendable; quarantined contacts preserve unresolved legacy history';

CREATE INDEX "Contact_state_idx" ON "Contact"("state");

COMMIT;
