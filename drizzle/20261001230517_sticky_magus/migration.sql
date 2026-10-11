CREATE TYPE "lead_source" AS ENUM('google_ads', 'meta_ads', 'whatsapp');--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "adGroupId" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "adId" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "adSetId" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "campaignId" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "gclid" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "source" "lead_source" DEFAULT 'whatsapp'::"lead_source" NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "sourceLeadId" text;--> statement-breakpoint
ALTER TABLE "leads" DROP COLUMN "urgency";--> statement-breakpoint
ALTER TABLE "leads" ALTER COLUMN "objective" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ALTER COLUMN "consortiumType" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_source_source_lead_id_unique" UNIQUE("source","sourceLeadId");