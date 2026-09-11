CREATE TYPE "lead_urgency" AS ENUM('immediate', 'short_term', 'medium_term', 'long_term');--> statement-breakpoint
CREATE TYPE "lead_commercial_approach" AS ENUM('vehicle_renewal', 'operational_cost', 'cash_purchase_power', 'investment_discipline', 'quota_bank', 'fleet', 'general');--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "painPoint" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "urgency" "lead_urgency";--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "currentSituation" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "commercialApproach" "lead_commercial_approach";--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "qualifiedAt" timestamp with time zone;--> statement-breakpoint
