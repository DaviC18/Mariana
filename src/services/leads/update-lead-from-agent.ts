/** biome-ignore-all lint/style/useFilenamingConvention: <> */

import { eq } from "drizzle-orm";

import { db } from "../../db/connections";
import { leads } from "../../db/schema";
import { canTransitionLeadStatus, type LeadStatus } from "./lead-status";

export interface UpdateLeadFromAgentInput {
	appointmentCreated?: boolean;
	currentStatus: string;
	leadId: string;
	leadUpdate: {
		consortiumType?: string | null;
		objective?: string | null;
		status: string;
	};
}

interface PersistLeadInput {
	leadId: string;
	values: {
		consortiumType?: string;
		objective?: string;
		status: LeadStatus;
		updatedAt: Date;
	};
}

export type PersistLeadFn = (
	input: PersistLeadInput
) => Promise<{ id: string }>;

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

	if (values.objective !== undefined) {
		updatePayload.objective = values.objective;
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
	leadId,
	leadUpdate,
	persistLead = defaultPersistLead,
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

	if (
		leadUpdate.consortiumType !== null &&
		leadUpdate.consortiumType !== undefined
	) {
		const trimmedConsortiumType = leadUpdate.consortiumType.trim();
		if (trimmedConsortiumType.length > 0) {
			values.consortiumType = trimmedConsortiumType;
		}
	}

	if (leadUpdate.objective !== null && leadUpdate.objective !== undefined) {
		const trimmedObjective = leadUpdate.objective.trim();
		if (trimmedObjective.length > 0) {
			values.objective = trimmedObjective;
		}
	}

	return await persistLead({ leadId, values });
}
