/** biome-ignore-all lint/correctness/noUnusedVariables: <> */
/** biome-ignore-all lint/suspicious/noEvolvingTypes: <> */
/** biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: <> */
/** biome-ignore-all lint/style/noParameterProperties: <> */
import { and, eq } from "drizzle-orm";

import { db } from "../../db/connections";
import { leads } from "../../db/schema";

export type LeadIngestionSource = "google_ads" | "meta_ads" | "whatsapp";

export interface LeadIngestionInput {
	adGroupId?: string;
	adId?: string;
	adSetId?: string;
	birthDate?: Date;
	campaignId?: string;
	consortiumType?: string;
	email?: string;
	gclid?: string;
	name?: string;
	objective?: string;
	phone: string;
	source: LeadIngestionSource;
	sourceLeadId?: string;
}

const SOURCE_PRIORITY = {
	google_ads: 1,
	meta_ads: 1,
	whatsapp: 0,
} as const;

function normalizePhone(phone: string): string {
	return phone.replace(/\D/g, "");
}

function hasValue<T>(value: T | undefined): value is T {
	return value !== undefined && value !== null;
}

export class LeadIngestionService {
	constructor(private readonly database = db) {}

	async ingest(input: LeadIngestionInput) {
		const phone = normalizePhone(input.phone);

		if (!phone) {
			throw new Error("Lead phone is required");
		}

		let existingLead = null;

		if (input.sourceLeadId) {
			const [leadBySource] = await this.database
				.select()
				.from(leads)
				.where(
					and(
						eq(leads.source, input.source),
						eq(leads.sourceLeadId, input.sourceLeadId)
					)
				)
				.limit(1);

			existingLead = leadBySource ?? null;
		}

		if (!existingLead) {
			const [leadByPhone] = await this.database
				.select()
				.from(leads)
				.where(eq(leads.phone, phone))
				.limit(1);

			existingLead = leadByPhone ?? null;
		}

		if (!existingLead) {
			const [createdLead] = await this.database
				.insert(leads)
				.values({
					adGroupId: input.adGroupId ?? null,
					adId: input.adId ?? null,
					adSetId: input.adSetId ?? null,
					birthDate: input.birthDate,
					campaignId: input.campaignId ?? null,
					consortiumType: input.consortiumType?.trim() || null,
					email: input.email,
					gclid: input.gclid ?? null,
					name: input.name?.trim() || phone,
					objective: input.objective?.trim() || null,
					phone,
					source: input.source,
					sourceLeadId:
						input.source === "whatsapp" ? null : (input.sourceLeadId ?? null),
				})
				.returning();

			if (!createdLead) {
				throw new Error("Failed to create lead");
			}

			return {
				created: true,
				lead: createdLead,
			};
		}

		const shouldUpgradeSource =
			SOURCE_PRIORITY[input.source] > SOURCE_PRIORITY[existingLead.source];

		const effectiveSource = shouldUpgradeSource
			? input.source
			: existingLead.source;

		const updateValues: Record<string, unknown> = {};

		if (
			input.name &&
			(existingLead.source === input.source ||
				!existingLead.name ||
				existingLead.name === existingLead.phone)
		) {
			updateValues.name = input.name.trim();
		}

		if (input.email) {
			updateValues.email = input.email.trim();
		}

		if (input.birthDate) {
			updateValues.birthDate = input.birthDate;
		}

		if (input.objective) {
			updateValues.objective = input.objective.trim();
		}

		if (input.consortiumType) {
			updateValues.consortiumType = input.consortiumType.trim();
		}

		if (effectiveSource !== "whatsapp") {
			if (input.gclid) {
				updateValues.gclid = input.gclid;
			}

			if (input.campaignId) {
				updateValues.campaignId = input.campaignId;
			}

			if (input.adGroupId) {
				updateValues.adGroupId = input.adGroupId;
			}

			if (input.adSetId) {
				updateValues.adSetId = input.adSetId;
			}

			if (input.adId) {
				updateValues.adId = input.adId;
			}

			if (
				input.sourceLeadId &&
				(existingLead.sourceLeadId === null || shouldUpgradeSource)
			) {
				updateValues.sourceLeadId = input.sourceLeadId;
			}
		}

		if (shouldUpgradeSource) {
			updateValues.source = input.source;
		}

		if (Object.keys(updateValues).length === 0) {
			return {
				created: false,
				lead: existingLead,
			};
		}

		const [updatedLead] = await this.database
			.update(leads)
			.set({
				...updateValues,
				updatedAt: new Date(),
			})
			.where(eq(leads.id, existingLead.id))
			.returning();

		if (!updatedLead) {
			throw new Error("Failed to update lead");
		}

		return {
			created: false,
			lead: updatedLead,
		};
	}
}

export const leadIngestionService = new LeadIngestionService();
