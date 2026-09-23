import { and, eq } from "drizzle-orm";

import { db as defaultDb } from "../../db/connections";
import {
	conversations,
	messages,
	schedulingSessions,
	schedulingSlots,
} from "../../db/schema";
import type { ConsultantAvailableSlot } from "./consultant-availability";

export interface PersistSchedulingOfferParams {
	conversationId: string;
	db?: typeof defaultDb;
	finalReply: string;
	leadId: string;
	messageId: string;
	now?: Date;
	offeredSlots: ConsultantAvailableSlot[];
}

export interface PersistSchedulingOfferResult {
	session: typeof schedulingSessions.$inferSelect;
	slots: (typeof schedulingSlots.$inferSelect)[];
	updatedAssistantMessage: typeof messages.$inferSelect;
}

export class SchedulingOfferService {
	private readonly db: typeof defaultDb;

	constructor(database = defaultDb) {
		this.db = database;
	}

	async persistOffer({
		conversationId,
		finalReply,
		leadId,
		messageId,
		now = new Date(),
		offeredSlots,
	}: PersistSchedulingOfferParams): Promise<PersistSchedulingOfferResult> {
		if (offeredSlots.length === 0) {
			throw new Error("Cannot persist scheduling offer with 0 slots");
		}

		const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);

		return await this.db.transaction(async (tx) => {
			// 1. Localizar e fechar session active anterior do mesmo lead
			await tx
				.update(schedulingSessions)
				.set({
					status: "closed",
					updatedAt: now,
				})
				.where(
					and(
						eq(schedulingSessions.leadId, leadId),
						eq(schedulingSessions.status, "active")
					)
				);

			// 2. Criar a nova session active
			const [createdSession] = await tx
				.insert(schedulingSessions)
				.values({
					conversationId,
					createdAt: now,
					expiresAt,
					leadId,
					status: "active",
					updatedAt: now,
				})
				.returning();

			if (!createdSession) {
				throw new Error("Failed to create scheduling session");
			}

			// 3. Criar os slots ofertados
			const slotsToInsert = offeredSlots.map((slot, index) => ({
				calendarId: slot.consultant.calendarId,
				consultantId: slot.consultant.id,
				consultantName: slot.consultant.name,
				createdAt: now,
				endAt: slot.end,
				position: index + 1,
				schedulingSessionId: createdSession.id,
				startAt: slot.start,
			}));

			const createdSlots = await tx
				.insert(schedulingSlots)
				.values(slotsToInsert)
				.returning();

			// 4. Atualizar a mensagem assistente existente com finalReply
			const [updatedAssistantMessage] = await tx
				.update(messages)
				.set({
					content: finalReply,
				})
				.where(eq(messages.id, messageId))
				.returning();

			if (!updatedAssistantMessage) {
				throw new Error("Assistant message not found for update");
			}

			// 5. Atualizar conversation updatedAt para consistência
			await tx
				.update(conversations)
				.set({
					updatedAt: now,
				})
				.where(eq(conversations.id, conversationId));

			return {
				session: createdSession,
				slots: createdSlots,
				updatedAssistantMessage,
			};
		});
	}
}
