ALTER TABLE "leads"
  ADD COLUMN IF NOT EXISTS "interestedInConsultant" boolean NOT NULL DEFAULT false;
