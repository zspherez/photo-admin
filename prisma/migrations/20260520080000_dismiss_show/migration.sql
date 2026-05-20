-- Per-show dismissal: hides a show from the dashboard until restored.
ALTER TABLE "Show" ADD COLUMN "dismissedAt" TIMESTAMP(3);
CREATE INDEX "Show_dismissedAt_idx" ON "Show"("dismissedAt");
