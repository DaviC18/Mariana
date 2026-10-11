CREATE TYPE "lead_commercial_approach" AS ENUM('vehicle_renewal', 'operational_cost', 'cash_purchase_power', 'investment_discipline', 'quota_bank', 'fleet', 'general');--> statement-breakpoint
CREATE TYPE "lead_urgency" AS ENUM('immediate', 'short_term', 'medium_term', 'long_term');--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "birthDate" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "painPoint" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "urgency" "lead_urgency";--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "currentSituation" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "commercialApproach" "lead_commercial_approach";--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "qualifiedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointments" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "appointments" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
DROP TYPE "appointment_status";--> statement-breakpoint
CREATE TYPE "appointment_status" AS ENUM('pending_confirmation', 'confirmed', 'expired', 'cancelled', 'completed', 'scheduled');--> statement-breakpoint
ALTER TABLE "appointments" ALTER COLUMN "status" SET DATA TYPE "appointment_status" USING "status"::"appointment_status";--> statement-breakpoint
ALTER TABLE "appointments" ALTER COLUMN "status" SET DEFAULT 'pending_confirmation'::"appointment_status";