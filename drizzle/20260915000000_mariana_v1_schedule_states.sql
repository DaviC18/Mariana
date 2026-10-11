ALTER TYPE "appointment_status" ADD VALUE IF NOT EXISTS 'pending_confirmation';
ALTER TYPE "appointment_status" ADD VALUE IF NOT EXISTS 'confirmed';
ALTER TYPE "appointment_status" ADD VALUE IF NOT EXISTS 'expired';

ALTER TABLE "appointments"
  ALTER COLUMN "status" SET DEFAULT 'pending_confirmation';
