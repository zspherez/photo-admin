BEGIN;

ALTER TABLE "TrajectoryModelRun"
  DROP CONSTRAINT "TrajectoryModelRun_freshness_check",
  ADD CONSTRAINT "TrajectoryModelRun_freshness_check"
    CHECK ("validUntil" = "generatedAt" + INTERVAL '168 hours');

COMMIT;
