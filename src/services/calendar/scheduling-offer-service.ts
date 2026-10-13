import { and, eq, gt, lte } from "drizzle-orm";

import { db as defaultDb } from "../../db/connections";
import {
	conversations,
	messages,
	schedulingSessions,
	schedulingSlots,
} from "../../db/schema";
import { enqueueTask } from "../../routes/whatsapp/webhook-whatsapp";
import { SEND_CONSULTANT_PREFERENCE_QUESTION_TASK } from "../../services/conversations/autonomous-task-handlers";
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

export function buildWhatsAppSchedulingOffer(
	slots: (typeof schedulingSlots.$inferSelect)[]
) {
	return {
		body: "Tenho estes horários disponíveis. Escolha uma opção:",
		buttons: slots.map((slot) => ({
			id: slot.id,
			title: new Intl.DateTimeFormat("pt-BR", {
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
				month: "2-digit",
				timeZone: "America/Sao_Paulo",
			})
				.format(slot.startAt)
				.replace(",", " às"),
		})),
	};
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
			// 1. Expirar sessions vencidas antes de fechar uma oferta ainda válida.
			await tx
				.update(schedulingSessions)
				.set({
					status: "expired",
					updatedAt: now,
				})
				.where(
					and(
						eq(schedulingSessions.leadId, leadId),
						eq(schedulingSessions.status, "active"),
						lte(schedulingSessions.expiresAt, now)
					)
				);

			// 2. Fechar session active anterior ainda válida do mesmo lead.
			await tx
				.update(schedulingSessions)
				.set({
					status: "closed",
					updatedAt: now,
				})
				.where(
					and(
						eq(schedulingSessions.leadId, leadId),
						eq(schedulingSessions.status, "active"),
						gt(schedulingSessions.expiresAt, now)
					)
				);

			// 3. Criar a nova session active com workflowStage inicial
			const [createdSession] = await tx
				.insert(schedulingSessions)
				.values({
					conversationId,
					createdAt: now,
					expiresAt,
					leadId,
					status: "active",
					updatedAt: now,
					workflowStage: "awaiting_availability",
				})
				.returning();

			if (!createdSession) {
				throw new Error("Failed to create scheduling session");
			}

			// 4. Criar os slots ofertados
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
			const session = createdSession;

			// 5. Atualizar a mensagem assistente existente com finalReply
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

			// 6. Atualizar conversation updatedAt para consistência
			await tx
				.update(conversations)
				.set({
					updatedAt: now,
				})
				.where(eq(conversations.id, conversationId));

			return {
				session,
				slots: createdSlots,
				updatedAssistantMessage,
			};
		});
	}

	/**
	 * Enfileira a tarefa para enviar a pergunta de preferência de consultor
	 * após a oferta de agendamento ser persistida.
	 */
	async enqueueConsultantPreferenceQuestion({
		conversationId,
		schedulingSessionId,
		eventId,
	}: {
		conversationId: string;
		schedulingSessionId: string;
		eventId?: string;
	}): Promise<void> {
		await enqueueTask({
			conversationId,
			idempotencyKey: `consultant-preference-question:${schedulingSessionId}`,
			payload: {
				eventId,
				kind: "send_consultant_preference_question",
				schedulingSessionId,
			},
			taskType: SEND_CONSULTANT_PREFERENCE_QUESTION_TASK,
		});
	}
}
