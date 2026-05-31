-- DropForeignKey
ALTER TABLE "Outreach" DROP CONSTRAINT "Outreach_artistId_fkey";

-- AlterTable
ALTER TABLE "Outreach" ADD COLUMN     "scheduledFor" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Outreach_status_scheduledFor_idx" ON "Outreach"("status", "scheduledFor");

-- AddForeignKey
ALTER TABLE "Outreach" ADD CONSTRAINT "Outreach_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "Artist"("id") ON DELETE CASCADE ON UPDATE CASCADE;
