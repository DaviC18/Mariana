ALTER TABLE "conversations" ADD COLUMN "lastCustomerMessageAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "optOutAt" timestamp with time zone;