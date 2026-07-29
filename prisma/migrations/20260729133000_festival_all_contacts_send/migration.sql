BEGIN;

ALTER TABLE "Outreach"
ADD COLUMN "festivalAllContactsSend" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Outreach"
ADD CONSTRAINT "Outreach_festival_all_contacts_check"
CHECK (
  "festivalAllContactsSend" = false
  OR "fullTeamSend" = true
);

COMMIT;
