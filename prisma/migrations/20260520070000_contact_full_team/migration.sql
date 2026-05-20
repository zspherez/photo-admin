-- "full team(s)" markers in the Sheet email column should be flagged on the
-- contact rather than stored inline in the email field.

ALTER TABLE "Contact" ADD COLUMN "isFullTeam" BOOLEAN NOT NULL DEFAULT false;
