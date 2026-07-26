BEGIN;

ALTER TABLE "TrajectoryModelRun"
  DROP CONSTRAINT "TrajectoryModelRun_freshness_check";

UPDATE "TrajectoryModelRun"
SET
  "validUntil" = "generatedAt" + INTERVAL '168 hours',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "validUntil" IS DISTINCT FROM
  "generatedAt" + INTERVAL '168 hours';

ALTER TABLE "TrajectoryModelRun"
  ADD CONSTRAINT "TrajectoryModelRun_freshness_check"
    CHECK ("validUntil" = "generatedAt" + INTERVAL '168 hours');

COMMIT;
