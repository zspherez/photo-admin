BEGIN;

CREATE TABLE "DashboardShowSnapshot" (
  "id" TEXT NOT NULL,
  "ownerKey" TEXT NOT NULL,
  "queryKey" TEXT NOT NULL,
  "total" INTEGER NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "DashboardShowSnapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DashboardShowSnapshot_ownerKey_check"
    CHECK (char_length("ownerKey") = 64 AND "ownerKey" ~ '^[0-9a-f]+$'),
  CONSTRAINT "DashboardShowSnapshot_queryKey_check"
    CHECK (char_length("queryKey") = 64 AND "queryKey" ~ '^[0-9a-f]+$'),
  CONSTRAINT "DashboardShowSnapshot_total_check"
    CHECK ("total" >= 0),
  CONSTRAINT "DashboardShowSnapshot_expiry_check"
    CHECK ("expiresAt" > "createdAt")
);

CREATE TABLE "DashboardShowSnapshotMember" (
  "snapshotId" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "showId" TEXT NOT NULL,
  "sortDate" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "DashboardShowSnapshotMember_pkey"
    PRIMARY KEY ("snapshotId", "position"),
  CONSTRAINT "DashboardShowSnapshotMember_position_check"
    CHECK ("position" >= 0),
  CONSTRAINT "DashboardShowSnapshotMember_sortDate_check"
    CHECK ("sortDate" = date_trunc('day', "sortDate"))
);

CREATE INDEX "DashboardShowSnapshot_expiresAt_idx"
  ON "DashboardShowSnapshot"("expiresAt");
CREATE INDEX "DashboardShowSnapshot_ownerKey_queryKey_expiresAt_idx"
  ON "DashboardShowSnapshot"("ownerKey", "queryKey", "expiresAt");
CREATE UNIQUE INDEX "DashboardShowSnapshotMember_snapshotId_showId_key"
  ON "DashboardShowSnapshotMember"("snapshotId", "showId");
CREATE INDEX "DashboardShowSnapshotMember_showId_idx"
  ON "DashboardShowSnapshotMember"("showId");

ALTER TABLE "DashboardShowSnapshotMember"
  ADD CONSTRAINT "DashboardShowSnapshotMember_snapshotId_fkey"
  FOREIGN KEY ("snapshotId") REFERENCES "DashboardShowSnapshot"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DashboardShowSnapshotMember"
  ADD CONSTRAINT "DashboardShowSnapshotMember_showId_fkey"
  FOREIGN KEY ("showId") REFERENCES "Show"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
