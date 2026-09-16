/** biome-ignore-all lint/style/useFilenamingConvention: <> */

import { eq } from "drizzle-orm";

import { db } from "../../db/connections";
import { leads } from "../../db/schema";
import { isAtLeast18, isLeadQualified } from "./lead-qualification";
import { canTransitionLeadStatus, type LeadStatus } from "./lead-status";

const VALID_URGENCIES = [
	"immediate",
	"short_term",
	"medium_term",
	"long_term",
] as const;

const VALID_COMMERCIAL_APPROACHES = [
	"vehicle_renewal",
	"operational_cost",
	"cash_purchase_power",
	"investment_discipline",
	"quota_bank",
	"fleet",
	"general",
] as const;

export interface UpdateLeadFromAgentInput {
	appointmentCreated?: boolean;
	currentStatus: string;
	existingLead?: {
		birthDate?: Date | null;
		consortiumType?: string | null;
		currentSituation?: string | null;
		motivation?: string | null;
		objective?: string | null;
		painPoint?: string | null;
	};
	interestedInConsultant?: boolean | null;
	leadId: string;
	leadUpdate: {
		birthDate?: Date | null;
		commercialApproach?: string | null;
		consortiumType?: string | null;
		currentSituation?: string | null;
		interestedInConsultant?: boolean | null;
		motivation?: string | null;
		objective?: string | null;
		painPoint?: string | null;
		status: string;
		urgency?: string | null;
	};
	qualifiedAt?: Date;
}

interface PersistLeadInput {
	leadId: string;
	values: {
		birthDate?: Date;
		commercialApproach?: (typeof VALID_COMMERCIAL_APPROACHES)[number];
		consortiumType?: string;
		currentSituation?: string;
		objective?: string;
		painPoint?: string;
		qualifiedAt?: Date;
		status: LeadStatus;
		urgency?: (typeof VALID_URGENCIES)[number];
		updatedAt: Date;
	};
}

export type PersistLeadFn = (
	input: PersistLeadInput
) => Promise<{ id: string }>;

function buildQualifiedCandidate(
	leadUpdate: UpdateLeadFromAgentInput["leadUpdate"],
	existingLead?: UpdateLeadFromAgentInput["existingLead"],
	interestedInConsultant?: boolean | null
) {
	const effectiveInterestedInConsultant =
		leadUpdate.interestedInConsultant ?? interestedInConsultant;

	return {
		birthDate: leadUpdate.birthDate ?? existingLead?.birthDate,
		consortiumType: normalizeText(
			leadUpdate.consortiumType ?? existingLead?.consortiumType
		),
		currentSituation: normalizeText(
			leadUpdate.currentSituation ?? existingLead?.currentSituation
		),
		interestedInConsultant: effectiveInterestedInConsultant,
		motivation: normalizeText(
			leadUpdate.motivation ?? existingLead?.motivation
		),
		objective: normalizeText(leadUpdate.objective ?? existingLead?.objective),
		painPoint: normalizeText(
			leadUpdate.painPoint ??
				leadUpdate.motivation ??
				existingLead?.painPoint ??
				existingLead?.motivation
		),
	};
}

function applyNormalizedLeadValues(
	values: PersistLeadInput["values"],
	leadUpdate: UpdateLeadFromAgentInput["leadUpdate"]
) {
	if (leadUpdate.birthDate !== null && leadUpdate.birthDate !== undefined) {
		values.birthDate = leadUpdate.birthDate;
	}
	if (
		leadUpdate.consortiumType !== null &&
		leadUpdate.consortiumType !== undefined
	) {
		const trimmedConsortiumType = normalizeText(leadUpdate.consortiumType);
		if (trimmedConsortiumType) {
			values.consortiumType = trimmedConsortiumType;
		}
	}

	if (leadUpdate.objective !== null && leadUpdate.objective !== undefined) {
		const trimmedObjective = normalizeText(leadUpdate.objective);
		if (trimmedObjective) {
			values.objective = trimmedObjective;
		}
	}

	const normalizedPainPoint = normalizeText(
		leadUpdate.painPoint ?? leadUpdate.motivation ?? undefined
	);
	if (normalizedPainPoint) {
		values.painPoint = normalizedPainPoint;
	}

	const normalizedCurrentSituation = normalizeText(leadUpdate.currentSituation);
	if (normalizedCurrentSituation) {
		values.currentSituation = normalizedCurrentSituation;
	}

	const normalizedUrgency = validateControlledValue(
		leadUpdate.urgency,
		VALID_URGENCIES
	);
	if (normalizedUrgency) {
		values.urgency = normalizedUrgency;
	}

	const normalizedCommercialApproach = validateControlledValue(
		leadUpdate.commercialApproach,
		VALID_COMMERCIAL_APPROACHES
	);
	if (normalizedCommercialApproach) {
		values.commercialApproach = normalizedCommercialApproach;
	}
}

function resolveQualifiedAtValue({
	currentStatus,
	normalizedStatus,
	qualifiedAt,
}: {
	currentStatus: string;
	normalizedStatus: LeadStatus;
	qualifiedAt?: Date;
}) {
	if (
		normalizedStatus === "qualified" &&
		currentStatus !== "qualified" &&
		!qualifiedAt
	) {
		return new Date();
	}

	if (normalizedStatus === "qualified" && currentStatus !== "qualified") {
		return qualifiedAt ?? new Date();
	}

	if (currentStatus === "qualified" && qualifiedAt) {
		return qualifiedAt;
	}
}

function normalizeText(value: string | null | undefined): string | undefined {
	if (value === null || value === undefined) {
		return undefined;
	}

	const trimmedValue = value.trim();
	return trimmedValue.length > 0 ? trimmedValue : undefined;
}

function validateControlledValue<T extends readonly string[]>(
	value: string | null | undefined,
	allowedValues: T
): T[number] | undefined {
	if (value === null || value === undefined) {
		return undefined;
	}

	if (!allowedValues.includes(value as T[number])) {
		throw new Error(`Invalid value: ${value}`);
	}

	return value as T[number];
}

async function defaultPersistLead({
	leadId,
	values,
}: PersistLeadInput): Promise<{ id: string }> {
	const updatePayload: Record<string, string | Date> = {
		status: values.status,
		updatedAt: values.updatedAt,
	};

	if (values.consortiumType !== undefined) {
		updatePayload.consortiumType = values.consortiumType;
	}

	if (values.birthDate !== undefined) {
		updatePayload.birthDate = values.birthDate;
	}

	if (values.objective !== undefined) {
		updatePayload.objective = values.objective;
	}

	if (values.painPoint !== undefined) {
		updatePayload.painPoint = values.painPoint;
	}

	if (values.currentSituation !== undefined) {
		updatePayload.currentSituation = values.currentSituation;
	}

	if (values.urgency !== undefined) {
		updatePayload.urgency = values.urgency;
	}

	if (values.commercialApproach !== undefined) {
		updatePayload.commercialApproach = values.commercialApproach;
	}

	if (values.qualifiedAt !== undefined) {
		updatePayload.qualifiedAt = values.qualifiedAt;
	}

	const [updatedLead] = await db
		.update(leads)
		.set(updatePayload)
		.where(eq(leads.id, leadId))
		.returning();

	if (!updatedLead) {
		throw new Error("Lead not found");
	}

	return updatedLead;
}

export async function updateLeadFromAgent({
	appointmentCreated = false,
	currentStatus,
	existingLead,
	interestedInConsultant,
	leadId,
	leadUpdate,
	persistLead = defaultPersistLead,
	qualifiedAt,
}: UpdateLeadFromAgentInput & {
	persistLead?: PersistLeadFn;
}): Promise<{ id: string }> {
	if (!canTransitionLeadStatus(currentStatus, leadUpdate.status)) {
		throw new Error(
			`Invalid lead status transition from ${currentStatus} to ${leadUpdate.status}`
		);
	}

	if (leadUpdate.status === "scheduled" && !appointmentCreated) {
		throw new Error(
			"Lead cannot be scheduled without an explicit appointment confirmation"
		);
	}

	const normalizedStatus = leadUpdate.status as LeadStatus;
	const values: PersistLeadInput["values"] = {
		status: normalizedStatus,
		updatedAt: new Date(),
	};

	const qualifiedCandidate = buildQualifiedCandidate(
		leadUpdate,
		existingLead,
		interestedInConsultant
	);

	if (
		qualifiedCandidate.birthDate !== null &&
		qualifiedCandidate.birthDate !== undefined &&
		!isAtLeast18(qualifiedCandidate.birthDate)
	) {
		throw new Error("Lead must be at least 18 years old");
	}

	if (
		normalizedStatus === "qualified" &&
		!isLeadQualified(qualifiedCandidate)
	) {
		throw new Error(
			"Lead cannot be qualified without objective, consortiumType, painPoint or motivation, currentSituation, and explicit interest in consultant"
		);
	}

	applyNormalizedLeadValues(values, leadUpdate);

	const resolvedQualifiedAt = resolveQualifiedAtValue({
		currentStatus,
		normalizedStatus,
		qualifiedAt,
	});
	if (resolvedQualifiedAt) {
		values.qualifiedAt = resolvedQualifiedAt;
	}

	return await persistLead({ leadId, values });
}
