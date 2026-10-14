/** biome-ignore-all assist/source/useSortedKeys: <> */
/** biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: <> */
/** biome-ignore-all lint/style/useFilenamingConvention: <> */

import { and, asc, eq, gt, gte, inArray, isNull, lte, or } from "drizzle-orm";

import { db } from "../../db/connections";
import {
	autonomousTasks,
	consultants,
	conversations,
	leads,
	messages,
	outboundMessages,
	schedulingSessions,
	schedulingSlots,
	whatsappWebhookEvents,
} from "../../db/schema";
import { formatSlotDate } from "../../utils/date-formatter";
import { SchedulingAvailabilityService } from "../calendar/scheduling-availability";
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
import {
	buildInboundReplyIdempotencyKey,
	getInboundBatchCutoffAt,
	selectInboundMessageBatch,
} from "./inbound-message-batch";

const schedulingChoiceService = new SchedulingChoiceService();
const schedulingConfirmationService = new SchedulingConfirmationService();
const schedulingConfirmationOrchestrator =
	new SchedulingConfirmationOrchestrator();
const schedulingCancellationService = new SchedulingCancellationService();
const _schedulingAvailabilityService = new SchedulingAvailabilityService();

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function markEventProcessed(eventId: string | undefined) {
	if (!(eventId && UUID_PATTERN.test(eventId))) {
		return;
	}

	const [eventExists] = await db
		.select({ id: whatsappWebhookEvents.id })
		.from(whatsappWebhookEvents)
		.where(eq(whatsappWebhookEvents.id, eventId))
		.limit(1);

	if (!eventExists) {
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
 * A task anchor owns a persisted debounce cohort. Only unprocessed user
 * messages referenced by inbound tasks in that cohort are included; stale
 * history without a matching task is never folded into the current reply.
 */
const handleProcessInboundMessage: AutonomousTaskHandler = async ({ task }) => {
	const { conversationId, payload: taskPayload, triggerMessageId } = task;
	const eventId = taskPayload?.eventId as string | undefined;
	if (!triggerMessageId) {
		throw new PermanentAutonomousTaskError("Inbound trigger message missing");
	}

	const [conversation] = await db
		.select({ id: conversations.id, leadId: conversations.leadId })
		.from(conversations)
		.where(eq(conversations.id, conversationId))
		.limit(1);

	if (!conversation) {
		throw new PermanentAutonomousTaskError("Conversation not found");
	}

	const batchCandidates = await db
		.select({
			content: messages.content,
			createdAt: messages.createdAt,
			id: messages.id,
			taskCreatedAt: autonomousTasks.createdAt,
			taskId: autonomousTasks.id,
			taskPayload: autonomousTasks.payload,
		})
		.from(autonomousTasks)
		.innerJoin(messages, eq(messages.id, autonomousTasks.triggerMessageId))
		.where(
			and(
				eq(autonomousTasks.conversationId, conversationId),
				eq(autonomousTasks.taskType, PROCESS_INBOUND_MESSAGE_TASK),
				inArray(autonomousTasks.status, ["pending", "processing"]),
				or(
					eq(autonomousTasks.id, task.id),
					and(
						gte(autonomousTasks.createdAt, task.createdAt),
						lte(autonomousTasks.createdAt, getInboundBatchCutoffAt(task))
					)
				),
				eq(messages.conversationId, conversationId),
				eq(messages.role, "user"),
				isNull(messages.processedAt)
			)
		)
		.orderBy(asc(autonomousTasks.createdAt), asc(autonomousTasks.id));
	const unprocessed = selectInboundMessageBatch({
		anchorTask: task,
		candidates: batchCandidates,
	});

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
	const runKey = buildInboundReplyIdempotencyKey(
		conversationId,
		triggerMessageId
	);

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

/**
 * Handler para enviar a pergunta de preferência de consultor após a disponibilidade ser calculada.
 * Transição: awaiting_availability → awaiting_consultant_preference
 */
const handleSendConsultantPreferenceQuestion: AutonomousTaskHandler = async ({
	task,
}) => {
	const { conversationId, payload: taskPayload } = task;
	const eventId = taskPayload?.eventId as string | undefined;
	const schedulingSessionId = taskPayload?.schedulingSessionId as
		| string
		| undefined;

	if (!schedulingSessionId) {
		throw new PermanentAutonomousTaskError(
			"Scheduling session id missing in payload"
		);
	}

	const [session] = await db
		.select({
			id: schedulingSessions.id,
			leadId: schedulingSessions.leadId,
			conversationId: schedulingSessions.conversationId,
			status: schedulingSessions.status,
			workflowStage: schedulingSessions.workflowStage,
		})
		.from(schedulingSessions)
		.where(eq(schedulingSessions.id, schedulingSessionId))
		.limit(1);

	if (!session || session.conversationId !== conversationId) {
		throw new PermanentAutonomousTaskError(
			"Scheduling session not found or mismatch"
		);
	}

	if (session.status !== "active") {
		await markEventProcessed(eventId);
		return { skipped: true, reason: "session_not_active" };
	}

	if (session.workflowStage !== "awaiting_availability") {
		await markEventProcessed(eventId);
		return { skipped: true, reason: "invalid_workflow_stage" };
	}

	const [lead] = await db
		.select({ id: leads.id, phone: leads.phone })
		.from(leads)
		.where(eq(leads.id, session.leadId))
		.limit(1);

	if (!lead) {
		throw new PermanentAutonomousTaskError("Lead not found");
	}

	// Atualizar workflow stage para awaiting_consultant_preference
	await db
		.update(schedulingSessions)
		.set({
			workflowStage: "awaiting_consultant_preference",
			updatedAt: new Date(),
		})
		.where(eq(schedulingSessions.id, schedulingSessionId));

	// Enviar pergunta de preferência com botões interativos
	const runKey = `consultant-preference:${conversationId}:${schedulingSessionId}`;

	const [existingOutbound] = await db
		.select({ id: outboundMessages.id })
		.from(outboundMessages)
		.where(eq(outboundMessages.idempotencyKey, runKey))
		.limit(1);

	if (existingOutbound) {
		await markEventProcessed(eventId);
		return { deduplicated: true };
	}

	await enqueueOutboundMessage({
		conversationId,
		eventId: undefined,
		idempotencyKey: runKey,
		leadId: lead.id,
		payload: buttonPayload({
			body: "Você tem preferência por algum consultor?",
			buttons: [
				{
					id: `pref:${session.id}:has_preference`,
					title: "Tenho preferência",
				},
				{
					id: `pref:${session.id}:no_preference`,
					title: "Sem preferência",
				},
			],
		}),
	});

	await markEventProcessed(eventId);
	return { consultantPreferenceQuestionSent: true };
};

/**
 * Handler para processar a resposta de preferência de consultor.
 * Transição: awaiting_consultant_preference → awaiting_consultant_selection (se tem preferência)
 * ou awaiting_consultant_preference → awaiting_slot_selection (se não tem preferência)
 */
const handleProcessConsultantPreferenceReply: AutonomousTaskHandler = async ({
	task,
}) => {
	const { conversationId, payload: taskPayload } = task;
	const eventId = taskPayload?.eventId as string | undefined;
	const buttonId = taskPayload?.buttonId as string | undefined;
	const externalId = taskPayload?.eventExternalId as string | undefined;

	const preferenceButtonParts = buttonId?.split(":") ?? [];
	if (
		preferenceButtonParts.length !== 3 ||
		preferenceButtonParts[0] !== "pref" ||
		!preferenceButtonParts[1] ||
		(preferenceButtonParts[2] !== "has_preference" &&
			preferenceButtonParts[2] !== "no_preference")
	) {
		throw new PermanentAutonomousTaskError(
			"Invalid consultant preference button id"
		);
	}
	const [, buttonSessionId, preference] = preferenceButtonParts;

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

	const [session] = await db
		.select()
		.from(schedulingSessions)
		.where(
			and(
				eq(schedulingSessions.leadId, lead.id),
				eq(schedulingSessions.conversationId, conversationId),
				eq(schedulingSessions.status, "active")
			)
		)
		.limit(1);

	if (session?.workflowStage !== "awaiting_consultant_preference") {
		await markEventProcessed(eventId);
		return { skipped: true, reason: "no_active_session_or_invalid_stage" };
	}

	if (session.id !== buttonSessionId) {
		await markEventProcessed(eventId);
		return { skipped: true, reason: "button_from_another_session" };
	}

	const runKey = `consultant-preference-reply:${conversationId}:${externalId ?? buttonId}`;

	const [existingOutbound] = await db
		.select({ id: outboundMessages.id })
		.from(outboundMessages)
		.where(eq(outboundMessages.idempotencyKey, runKey))
		.limit(1);

	if (existingOutbound) {
		await markEventProcessed(eventId);
		return { deduplicated: true };
	}

	const hasPreference = preference === "has_preference";

	if (hasPreference) {
		// Buscar consultores ativos com disponibilidade na sessão
		const slots = await db
			.select({
				consultantId: schedulingSlots.consultantId,
				consultantName: schedulingSlots.consultantName,
			})
			.from(schedulingSlots)
			.where(eq(schedulingSlots.schedulingSessionId, session.id))
			.groupBy(schedulingSlots.consultantId, schedulingSlots.consultantName);

		// Filtrar apenas consultores ativos
		const activeConsultantIds = slots.map((s) => s.consultantId);
		const activeConsultants = await db
			.select({ id: consultants.id, name: consultants.name })
			.from(consultants)
			.where(
				and(
					inArray(consultants.id, activeConsultantIds),
					eq(consultants.active, true)
				)
			);

		if (activeConsultants.length === 0) {
			// Nenhum consultor ativo com disponibilidade
			await enqueueOutboundMessage({
				conversationId,
				eventId: undefined,
				idempotencyKey: runKey,
				leadId: lead.id,
				payload: {
					kind: "text",
					text: "No momento, nenhum consultor com disponibilidade está ativo. Por favor, tente novamente mais tarde.",
				},
			});
			await markEventProcessed(eventId);
			return { noActiveConsultants: true };
		}

		// Atualizar workflow stage para awaiting_consultant_selection
		await db
			.update(schedulingSessions)
			.set({
				workflowStage: "awaiting_consultant_selection",
				updatedAt: new Date(),
			})
			.where(eq(schedulingSessions.id, session.id));

		// Enviar lista de consultores com botões
		await enqueueOutboundMessage({
			conversationId,
			eventId: undefined,
			idempotencyKey: runKey,
			leadId: lead.id,
			payload: buttonPayload({
				body: "Escolha um consultor:",
				buttons: activeConsultants.map((c) => ({
					id: `consultant:${session.id}:${c.id}`,
					title: c.name,
				})),
			}),
		});
	} else {
		// Sem preferência - avançar diretamente para seleção de slot
		// Deterministicamente, o primeiro consultor com slots disponíveis será usado
		const slots = await db
			.select()
			.from(schedulingSlots)
			.where(eq(schedulingSlots.schedulingSessionId, session.id))
			.orderBy(schedulingSlots.position)
			.limit(3);

		if (slots.length === 0) {
			await enqueueOutboundMessage({
				conversationId,
				eventId: undefined,
				idempotencyKey: runKey,
				leadId: lead.id,
				payload: {
					kind: "text",
					text: "No momento, não encontrei horários disponíveis. Por favor, tente novamente mais tarde.",
				},
			});
			await markEventProcessed(eventId);
			return { noSlotsAvailable: true };
		}

		// Atualizar workflow stage para awaiting_slot_selection
		await db
			.update(schedulingSessions)
			.set({
				workflowStage: "awaiting_slot_selection",
				updatedAt: new Date(),
			})
			.where(eq(schedulingSessions.id, session.id));

		// Enviar slots como botões
		await enqueueOutboundMessage({
			conversationId,
			eventId: undefined,
			idempotencyKey: runKey,
			leadId: lead.id,
			payload: buttonPayload({
				body: "Tenho estes horários disponíveis. Escolha uma opção:",
				buttons: slots.map((slot) => ({
					id: slot.id,
					title: formatSlotTitle(slot.startAt),
				})),
			}),
		});
	}

	await markEventProcessed(eventId);
	return { consultantPreferenceProcessed: true, hasPreference };
};

/**
 * Handler para processar a seleção de consultor.
 * Transição: awaiting_consultant_selection → awaiting_slot_selection
 */
const handleProcessConsultantSelection: AutonomousTaskHandler = async ({
	task,
}) => {
	const { conversationId, payload: taskPayload } = task;
	const eventId = taskPayload?.eventId as string | undefined;
	const buttonId = taskPayload?.buttonId as string | undefined;
	const externalId = taskPayload?.eventExternalId as string | undefined;

	const consultantButtonParts = buttonId?.split(":") ?? [];
	if (
		consultantButtonParts.length !== 3 ||
		consultantButtonParts[0] !== "consultant" ||
		!consultantButtonParts[1] ||
		!consultantButtonParts[2]
	) {
		throw new PermanentAutonomousTaskError(
			"Invalid consultant selection button id"
		);
	}
	const [, buttonSessionId, consultantId] = consultantButtonParts;

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

	const [session] = await db
		.select()
		.from(schedulingSessions)
		.where(
			and(
				eq(schedulingSessions.leadId, lead.id),
				eq(schedulingSessions.conversationId, conversationId),
				eq(schedulingSessions.status, "active")
			)
		)
		.limit(1);

	if (session?.workflowStage !== "awaiting_consultant_selection") {
		await markEventProcessed(eventId);
		return { skipped: true, reason: "no_active_session_or_invalid_stage" };
	}

	if (session.id !== buttonSessionId) {
		await markEventProcessed(eventId);
		return { skipped: true, reason: "button_from_another_session" };
	}

	// Verificar se o consultor selecionado está ativo e tem slots na sessão
	const [consultant] = await db
		.select({ id: consultants.id, active: consultants.active })
		.from(consultants)
		.where(eq(consultants.id, consultantId))
		.limit(1);

	if (!consultant?.active) {
		await markEventProcessed(eventId);
		return { skipped: true, reason: "consultant_not_active" };
	}

	const consultantSlots = await db
		.select()
		.from(schedulingSlots)
		.where(
			and(
				eq(schedulingSlots.schedulingSessionId, session.id),
				eq(schedulingSlots.consultantId, consultantId)
			)
		)
		.orderBy(schedulingSlots.position)
		.limit(3);

	if (consultantSlots.length === 0) {
		await markEventProcessed(eventId);
		return { skipped: true, reason: "consultant_no_slots" };
	}

	const runKey = `consultant-selection:${conversationId}:${externalId ?? buttonId}`;

	const [existingOutbound] = await db
		.select({ id: outboundMessages.id })
		.from(outboundMessages)
		.where(eq(outboundMessages.idempotencyKey, runKey))
		.limit(1);

	if (existingOutbound) {
		await markEventProcessed(eventId);
		return { deduplicated: true };
	}

	// Persistir preferência de consultor na sessão
	await db
		.update(schedulingSessions)
		.set({
			preferredConsultantId: consultantId,
			workflowStage: "awaiting_slot_selection",
			updatedAt: new Date(),
		})
		.where(eq(schedulingSessions.id, session.id));

	// Enviar slots do consultor selecionado
	await enqueueOutboundMessage({
		conversationId,
		eventId: undefined,
		idempotencyKey: runKey,
		leadId: lead.id,
		payload: buttonPayload({
			body: `Horários disponíveis com ${consultantSlots[0].consultantName}:`,
			buttons: consultantSlots.map((slot) => ({
				id: slot.id,
				title: formatSlotTitle(slot.startAt),
			})),
		}),
	});

	await markEventProcessed(eventId);
	return { consultantSelected: true, consultantId };
};

/**
 * Handler para enviar a solicitação de confirmação após seleção de slot.
 * Transição: awaiting_slot_selection → awaiting_confirmation
 */
const handleSendConfirmationRequest: AutonomousTaskHandler = async ({
	task,
}) => {
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

	const [session] = await db
		.select()
		.from(schedulingSessions)
		.where(
			and(
				eq(schedulingSessions.leadId, lead.id),
				eq(schedulingSessions.conversationId, conversationId),
				eq(schedulingSessions.status, "active")
			)
		)
		.limit(1);

	if (session?.workflowStage !== "awaiting_slot_selection") {
		await markEventProcessed(eventId);
		return { skipped: true, reason: "no_active_session_or_invalid_stage" };
	}

	// Validar e persistir a seleção do slot
	const choiceResult = await schedulingChoiceService.resolveChoice({
		buttonId,
		conversationId,
		leadId: lead.id,
	});

	if (!choiceResult.ok) {
		await markEventProcessed(eventId);
		return { skipped: true, reason: choiceResult.reason };
	}

	// Atualizar workflow stage para awaiting_confirmation
	const [confirmationSession] = await db
		.update(schedulingSessions)
		.set({
			workflowStage: "awaiting_confirmation",
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(schedulingSessions.id, session.id),
				eq(schedulingSessions.leadId, lead.id),
				eq(schedulingSessions.conversationId, conversationId),
				eq(schedulingSessions.status, "active"),
				eq(schedulingSessions.workflowStage, "awaiting_slot_selection"),
				eq(schedulingSessions.selectedSlotId, choiceResult.slot.id),
				gt(schedulingSessions.expiresAt, new Date())
			)
		)
		.returning({ id: schedulingSessions.id });

	if (!confirmationSession) {
		await markEventProcessed(eventId);
		return { skipped: true, reason: "session_changed_before_confirmation" };
	}

	const runKey = `confirmation-request:${conversationId}:${externalId ?? buttonId}`;

	const [existingOutbound] = await db
		.select({ id: outboundMessages.id })
		.from(outboundMessages)
		.where(eq(outboundMessages.idempotencyKey, runKey))
		.limit(1);

	if (existingOutbound) {
		await markEventProcessed(eventId);
		return { deduplicated: true };
	}

	// Enviar mensagem de confirmação com botões Confirmar/Não
	const confirmation = schedulingConfirmationService.buildConfirmationMessage(
		choiceResult.slot
	);

	await enqueueOutboundMessage({
		conversationId,
		eventId: undefined,
		idempotencyKey: runKey,
		leadId: lead.id,
		payload: buttonPayload(confirmation),
	});

	await markEventProcessed(eventId);
	return { confirmationRequestSent: true };
};

export const PROCESS_INBOUND_MESSAGE_TASK = "process_inbound_message";
export const PROCESS_BUTTON_REPLY_TASK = "process_button_reply";
export const SEND_CONSULTANT_PREFERENCE_QUESTION_TASK =
	"send_consultant_preference_question";
export const PROCESS_CONSULTANT_PREFERENCE_REPLY_TASK =
	"process_consultant_preference_reply";
export const PROCESS_CONSULTANT_SELECTION_TASK = "process_consultant_selection";
export const SEND_CONFIRMATION_REQUEST_TASK = "send_confirmation_request";

export function createAutonomousTaskHandlers(): Record<
	string,
	AutonomousTaskHandler
> {
	return {
		[PROCESS_BUTTON_REPLY_TASK]: handleProcessButtonReply,
		[PROCESS_INBOUND_MESSAGE_TASK]: handleProcessInboundMessage,
		[SEND_CONSULTANT_PREFERENCE_QUESTION_TASK]:
			handleSendConsultantPreferenceQuestion,
		[PROCESS_CONSULTANT_PREFERENCE_REPLY_TASK]:
			handleProcessConsultantPreferenceReply,
		[PROCESS_CONSULTANT_SELECTION_TASK]: handleProcessConsultantSelection,
		[SEND_CONFIRMATION_REQUEST_TASK]: handleSendConfirmationRequest,
	};
}
