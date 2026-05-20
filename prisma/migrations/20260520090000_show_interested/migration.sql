-- Per-show "interested" flag: a soft bookmark indicating "I might want to send".
ALTER TABLE "Show" ADD COLUMN "interestedAt" TIMESTAMP(3);
CREATE INDEX "Show_interestedAt_idx" ON "Show"("interestedAt");
