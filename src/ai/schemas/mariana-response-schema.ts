import { z } from "zod";

import {
	leadCommercialApproach,
	leadStatus,
	leadUrgency,
} from "../../db/schema/leads";

const marianaLeadStatus = z.enum(leadStatus.enumValues);
const marianaLeadUrgency = z.enum(leadUrgency.enumValues);
const marianaLeadCommercialApproach = z.enum(leadCommercialApproach.enumValues);

export const QUALIFICATION_REQUIRED_FIELDS = {
	commercialApproachValues: leadCommercialApproach.enumValues,
	urgencyValues: leadUrgency.enumValues,
} as const;

export const marianaResponseSchema = z.object({
	leadUpdate: z.object({
		commercialApproach: marianaLeadCommercialApproach.nullable().optional(),
		consortiumType: z.string().trim().min(1).nullable().optional(),
		currentSituation: z.string().trim().min(1).nullable().optional(),
		interestedInConsultant: z.boolean().optional(),
		motivation: z.string().trim().min(1).nullable().optional(),
		objective: z.string().trim().min(1).nullable().optional(),
		painPoint: z.string().trim().min(1).nullable().optional(),
		status: marianaLeadStatus,
		urgency: marianaLeadUrgency.nullable().optional(),
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
