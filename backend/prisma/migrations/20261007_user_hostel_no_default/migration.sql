-- New students are asked for their drop point at sign-up (and again at checkout) instead of silently getting "Boys Hostel Block 1".
-- Metadata only: existing rows keep their value.
ALTER TABLE "User" ALTER COLUMN "hostelBlock" DROP DEFAULT;
