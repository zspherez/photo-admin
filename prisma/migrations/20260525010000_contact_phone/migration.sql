-- Optional phone number. When set, the dashboard offers an "Open Messages"
-- shortcut instead of an email send.
ALTER TABLE "Contact" ADD COLUMN "phone" TEXT;
