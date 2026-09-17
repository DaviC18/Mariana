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

const v1BusinessActions = z.enum([
	"answer_basic_question",
	"answer_with_more_detail",
	"ask_next_qualification_question",
	"request_consultant",
	"offer_appointment",
	"wait_for_schedule",
	"close_conversation",
	"reject_out_of_scope",
]);

const legacyNextActions = z.enum([
	"continue_qualification",
	"offer_meeting",
	"schedule_meeting",
	"close",
]);

export const marianaResponseSchema = z.object({
	businessAction: v1BusinessActions.optional(),
	evidenceUsed: z.array(z.string().min(1)).optional(),
	extractedData: z.record(z.string(), z.any()).optional(),
	leadUpdate: z.object({
		birthDate: z.iso.date().nullable().optional(),
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
	missingData: z.array(z.string()).optional(),
	needsConfirmation: z.boolean().optional(),
	nextAction: z
		.union([legacyNextActions, v1BusinessActions])
		.default("continue_qualification"),
	reply: z.string().trim().min(1, "reply is required"),
	riskFlags: z.array(z.string()).optional(),
});

export type MarianaResponse = z.infer<typeof marianaResponseSchema>;
