/** biome-ignore-all assist/source/useSortedKeys: <> */
/** biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: <> */
/** biome-ignore-all lint/style/useFilenamingConvention: <> */

import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { db } from "../../db/connections";
import {
	conversations,
	leads,
	messages,
	outboundMessages,
	whatsappWebhookEvents,
} from "../../db/schema";
import { formatSlotDate } from "../../utils/date-formatter";
import { SchedulingCancellationService } from "../calendar/scheduling-cancellation-service";
import { SchedulingChoiceService } from "../calendar/scheduling-choice-service";
import { SchedulingConfirmationOrchestrator } from "../calendar/scheduling-confirmation-orchestrator";
import { SchedulingConfirmationService } from "../calendar/scheduling-confirmation-service";
import { buildWhatsAppSchedulingOffer } from "../calendar/scheduling-offer-service";
import {
	enqueueOutboundMessage,
	type OutboundMessagePayload,
} from "../messaging/outbound-messages";
import {
	type AutonomousTaskHandler,
	PermanentAutonomousTaskError,
} from "./autonomous-task-executor";
import { generateMarianaResponse } from "./generateMarianaResponse";

const schedulingChoiceService = new SchedulingChoiceService();
const schedulingConfirmationService = new SchedulingConfirmationService();
const schedulingConfirmationOrchestrator =
	new SchedulingConfirmationOrchestrator();
const schedulingCancellationService = new SchedulingCancellationService();

async function markEventProcessed(eventId: string | undefined) {
	if (!eventId) {
		return;
	}

	await db
		.update(whatsappWebhookEvents)
		.set({
			lastError: null,
			leaseExpiresAt: null,
			status: "processed",
			updatedAt: new Date(),
		})
		.where(eq(whatsappWebhookEvents.id, eventId));
}

async function markMessagesProcessed(messageIds: string[]) {
	if (messageIds.length === 0) {
		return;
	}

	await db
		.update(messages)
		.set({ processedAt: new Date() })
		.where(inArray(messages.id, messageIds));
}

function buttonPayload(payload: {
	body: string;
	buttons: Array<{ id: string; title: string }>;
}): OutboundMessagePayload {
	return {
		body: payload.body,
		buttons: payload.buttons,
		kind: "buttons",
	};
}

/**
 * Handler de mensagem de texto de entrada. Processa todas as mensagens ainda
 * não processadas da conversa como um lote (debounce durável), gera a resposta
 * da Mariana e a enfileira no outbox. É idempotente: a chave do outbox é
 * derivada da última mensagem do lote.
 */
const handleProcessInboundMessage: AutonomousTaskHandler = async ({ task }) => {
	const { conversationId, payload: taskPayload } = task;
	const eventId = taskPayload?.eventId as string | undefined;

	const [conversation] = await db
		.select({ id: conversations.id, leadId: conversations.leadId })
		.from(conversations)
		.where(eq(conversations.id, conversationId))
		.limit(1);

	if (!conversation) {
		throw new PermanentAutonomousTaskError("Conversation not found");
	}

	const unprocessed = await db
		.select({
			content: messages.content,
			createdAt: messages.createdAt,
			id: messages.id,
		})
		.from(messages)
		.where(
			and(
				eq(messages.conversationId, conversationId),
				eq(messages.role, "user"),
				isNull(messages.processedAt)
			)
		)
		.orderBy(asc(messages.createdAt));

	if (unprocessed.length === 0) {
		await markEventProcessed(eventId);
		return { skipped: true };
	}

	const lastMessage = unprocessed.at(-1);
	if (!lastMessage) {
		await markEventProcessed(eventId);
		return { skipped: true };
	}

	const messageIds = unprocessed.map((message) => message.id);
	const runKey = `mariana-reply:${conversationId}:${lastMessage.id}`;

	const [existingOutbound] = await db
		.select({ id: outboundMessages.id })
		.from(outboundMessages)
		.where(eq(outboundMessages.idempotencyKey, runKey))
		.limit(1);

	if (existingOutbound) {
		await markMessagesProcessed(messageIds);
		await markEventProcessed(eventId);
		return { deduplicated: true };
	}

	const messageCutoff = unprocessed.reduce(
		(latest, message) =>
			message.createdAt > latest ? message.createdAt : latest,
		lastMessage.createdAt
	);

	const marianaResult = await generateMarianaResponse({
		currentMessages: unprocessed.map((message) => message.content),
		leadId: conversation.leadId,
		messageCutoff,
		messageIds,
		persistUserMessage: false,
	});

	const assistantMessageId = marianaResult.assistantMessage?.id;

	const payload: OutboundMessagePayload = marianaResult.schedulingOffer
		? buttonPayload(
				marianaResult.schedulingOffer.slots.length === 1
					? schedulingConfirmationService.buildSingleSlotConfirmationMessage(
							marianaResult.schedulingOffer.slots[0]
						)
					: buildWhatsAppSchedulingOffer(marianaResult.schedulingOffer.slots)
			)
		: { kind: "text", text: marianaResult.result.reply };

	const [lead] = await db
		.select({ phone: leads.phone })
		.from(leads)
		.where(eq(leads.id, conversation.leadId))
		.limit(1);

	if (!lead) {
		throw new PermanentAutonomousTaskError("Lead not found");
	}

	await enqueueOutboundMessage({
		conversationId,
		eventId,
		idempotencyKey: runKey,
		leadId: conversation.leadId,
		messageId: assistantMessageId,
		payload,
	});

	await markMessagesProcessed(messageIds);
	await markEventProcessed(eventId);

	return { assistantMessageId, outboundQueued: true };
};

/**
 * Handler de resposta de botão. Reaproveita os fluxos determinísticos de
 * seleção, confirmação e cancelamento e enfileira a próxima mensagem no
 * outbox. Idempotente pela chave derivada do id externo do botão.
 */
const handleProcessButtonReply: AutonomousTaskHandler = async ({ task }) => {
	const { conversationId, payload: taskPayload } = task;
	const eventId = taskPayload?.eventId as string | undefined;
	const buttonId = taskPayload?.buttonId as string | undefined;
	const externalId = taskPayload?.eventExternalId as string | undefined;

	if (!buttonId) {
		throw new PermanentAutonomousTaskError("Button id missing in payload");
	}

	const [conversation] = await db
		.select({ id: conversations.id, leadId: conversations.leadId })
		.from(conversations)
		.where(eq(conversations.id, conversationId))
		.limit(1);

	if (!conversation) {
		throw new PermanentAutonomousTaskError("Conversation not found");
	}

	const [lead] = await db
		.select({ id: leads.id, phone: leads.phone })
		.from(leads)
		.where(eq(leads.id, conversation.leadId))
		.limit(1);

	if (!lead) {
		throw new PermanentAutonomousTaskError("Lead not found");
	}

	await db
		.update(conversations)
		.set({ lastCustomerMessageAt: new Date(), updatedAt: new Date() })
		.where(eq(conversations.id, conversationId));

	const runKey = `button-reply:${conversationId}:${externalId ?? buttonId}`;

	const [existingOutbound] = await db
		.select({ id: outboundMessages.id })
		.from(outboundMessages)
		.where(eq(outboundMessages.idempotencyKey, runKey))
		.limit(1);

	if (existingOutbound) {
		await markEventProcessed(eventId);
		return { deduplicated: true };
	}

	if (buttonId.startsWith("confirm:")) {
		const confirmationResult = await schedulingConfirmationOrchestrator.execute(
			{
				buttonId,
				conversationId,
				leadId: lead.id,
			}
		);

		if (confirmationResult.ok && confirmationResult.action === "confirm") {
			const { slot } = confirmationResult;

			await enqueueOutboundMessage({
				conversationId,
				eventId,
				idempotencyKey: runKey,
				leadId: lead.id,
				payload: {
					kind: "text",
					text: `Agendamento confirmado para ${formatSlotDate(slot.startAt)} com ${slot.consultantName}.`,
				},
			});
		}

		await markEventProcessed(eventId);
		return {
			action: confirmationResult.ok ? confirmationResult.action : "rejected",
		};
	}

	if (buttonId.startsWith("cancel:")) {
		const cancellationResult =
			await schedulingCancellationService.resolveCancellation({
				buttonId,
				conversationId,
				leadId: lead.id,
			});

		if (cancellationResult.ok && cancellationResult.action === "reoffer") {
			await enqueueOutboundMessage({
				conversationId,
				eventId,
				idempotencyKey: runKey,
				leadId: lead.id,
				payload: buttonPayload({
					body: "Tudo bem. Tenho estes horários disponíveis:",
					buttons: cancellationResult.slots.map((slot) => ({
						id: slot.id,
						title: formatSlotTitle(slot.startAt),
					})),
				}),
			});
		} else if (cancellationResult.ok && cancellationResult.action === "close") {
			await enqueueOutboundMessage({
				conversationId,
				eventId,
				idempotencyKey: runKey,
				leadId: lead.id,
				payload: {
					kind: "text",
					text: "Tudo bem. Esse horário não foi confirmado. Quando quiser, podemos consultar novos horários.",
				},
			});
		}

		await markEventProcessed(eventId);
		return {
			action: cancellationResult.ok ? cancellationResult.action : "rejected",
		};
	}

	const choiceResult = await schedulingChoiceService.resolveChoice({
		buttonId,
		conversationId,
		leadId: lead.id,
	});

	if (choiceResult.ok) {
		const confirmation = schedulingConfirmationService.buildConfirmationMessage(
			choiceResult.slot
		);

		await enqueueOutboundMessage({
			conversationId,
			eventId,
			idempotencyKey: runKey,
			leadId: lead.id,
			payload: buttonPayload(confirmation),
		});
	}

	await markEventProcessed(eventId);
	return { selected: choiceResult.ok };
};

function formatSlotTitle(startAt: Date): string {
	return new Intl.DateTimeFormat("pt-BR", {
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		month: "2-digit",
		timeZone: "America/Sao_Paulo",
	})
		.format(startAt)
		.replace(",", " às");
}

export const PROCESS_INBOUND_MESSAGE_TASK = "process_inbound_message";
export const PROCESS_BUTTON_REPLY_TASK = "process_button_reply";

export function createAutonomousTaskHandlers(): Record<
	string,
	AutonomousTaskHandler
> {
	return {
		[PROCESS_BUTTON_REPLY_TASK]: handleProcessButtonReply,
		[PROCESS_INBOUND_MESSAGE_TASK]: handleProcessInboundMessage,
	};
}
