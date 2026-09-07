import { z } from "zod";

import { leadStatus } from "../../db/schema/leads";

const marianaLeadStatus = z.enum(leadStatus.enumValues);

export const marianaResponseSchema = z.object({
	leadUpdate: z.object({
		consortiumType: z.string().trim().min(1).nullable(),
		objective: z.string().trim().min(1).nullable(),
		status: marianaLeadStatus,
	}),
	nextAction: z.enum([
		"continue_qualification",
		"offer_meeting",
		"schedule_meeting",
		"close",
	]),
	reply: z.string().trim().min(1, "reply is required"),
});

export type MarianaResponse = z.infer<typeof marianaResponseSchema>;
