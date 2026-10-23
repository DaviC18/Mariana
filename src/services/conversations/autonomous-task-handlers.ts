/** biome-ignore-all assist/source/useSortedKeys: <> */
/** biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: <> */
/** biome-ignore-all lint/performance/noAwaitInLoops: <> */
/** biome-ignore-all lint/style/useFilenamingConvention: <> */

import {
	and,
	asc,
	eq,
	gt,
	gte,
	inArray,
	isNull,
	lte,
	or,
	sql,
} from "drizzle-orm";
import { resolveModelName } from "../../ai/agent";
import { ModelUnavailableError } from "../../ai/model-errors";
import { db } from "../../db/connections";
import {
	appointments,
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
import { env } from "../../env";
import { enqueueTask } from "../../routes/whatsapp/webhook-whatsapp";
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
import { getOrCreateActiveConversation } from "./active-conversation";
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
import { MODEL_FAILURE_NOTICE } from "./model-failure-notice";
import {
	SESSION_CHOICE_ALREADY_RECORDED_TEXT,
	SESSION_CHOICE_CONTINUE_BUTTON_ID,
	SESSION_CHOICE_CONTINUE_BUTTON_TITLE,
	SESSION_CHOICE_NEW_BUTTON_ID,
	SESSION_CHOICE_NEW_BUTTON_TITLE,
	SESSION_CHOICE_NEW_CONVERSATION_CONFIRMATION_TEXT,
	SESSION_CHOICE_PENDING_INVALID_REPLY_TEXT,
	SESSION_CHOICE_QUESTION_TEXT,
	SESSION_CHOICE_REMINDER_TEXT,
} from "./session-choice-policy";
import {
	claimSessionChoice,
	readPendingSessionChoice,
	type SessionChoiceSnapshot,
	setQuestionMessage,
} from "./session-choice-store";

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
/**
 * Passo 11: o modelo falhou, então o cliente recebe o aviso aprovado em vez de
 * silêncio, e a task **conclui** — nada vai tentar de novo sozinho, o que é
 * exatamente o que o texto promete.
 *
 * Invariantes preservadas: usa o `runKey` que já existe, sem inventar uma
 * segunda chave de idempotência, então uma reexecução cai no dedup do outbox e
 * nenhuma mensagem possivelmente aceita pela Meta volta para `pending`; e
 * marca mensagens e evento como processados exatamente como o caminho de
 * sucesso, então nenhum evento de entrada é processado duas vezes.
 */
async function sendModelFailureNotice({
	conversationId,
	error,
	eventId,
	leadId,
	messageIds,
	runKey,
}: {
	conversationId: string;
	error: ModelUnavailableError;
	eventId: string | undefined;
	leadId: string;
	messageIds: string[];
	runKey: string;
}) {
	const [assistantMessage] = await db
		.insert(messages)
		.values({
			content: MODEL_FAILURE_NOTICE,
			conversationId,
			role: "assistant",
		})
		.returning({ id: messages.id });

	await enqueueOutboundMessage({
		conversationId,
		eventId,
		idempotencyKey: runKey,
		leadId,
		messageId: assistantMessage?.id,
		payload: { kind: "text", text: MODEL_FAILURE_NOTICE },
	});

	await markMessagesProcessed(messageIds);
	await markEventProcessed(eventId);

	console.error({
		conversationId,
		event: "mariana_model_failure",
		kind: error.kind,
		leadId,
		model: resolveModelName(),
	});

	return {
		assistantMessageId: assistantMessage?.id,
		modelFailureNotice: true,
		outboundQueued: true,
	};
}

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

	let marianaResult: Awaited<ReturnType<typeof generateMarianaResponse>>;

	try {
		marianaResult = await generateMarianaResponse({
			currentMessages: unprocessed.map((message) => message.content),
			leadId: conversation.leadId,
			messageCutoff,
			messageIds,
			persistUserMessage: false,
			// A task âncora identifica o turno no rastro.
			traceTurnId: task.id,
		});
	} catch (error) {
		// Só falha de modelo. Guardrail e erro de banco continuam falhando a
		// task como hoje: engolir tudo esconderia defeito de verdade.
		if (!(error instanceof ModelUnavailableError)) {
			throw error;
		}

		return await sendModelFailureNotice({
			conversationId,
			error,
			eventId,
			leadId: conversation.leadId,
			messageIds,
			runKey,
		});
	}

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

	// A transição e a mensagem são atômicas: se o outbox falhar, a sessão
	// continua em awaiting_availability e a nova tentativa reenvia a pergunta.
	await db.transaction(async (tx) => {
		await tx
			.update(schedulingSessions)
			.set({
				workflowStage: "awaiting_consultant_preference",
				updatedAt: new Date(),
			})
			.where(eq(schedulingSessions.id, schedulingSessionId));

		await enqueueOutboundMessage({
			conversationId,
			eventId: undefined,
			executor: tx,
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

		// Avança o workflow e envia a lista de consultores na mesma transação.
		await db.transaction(async (tx) => {
			await tx
				.update(schedulingSessions)
				.set({
					workflowStage: "awaiting_consultant_selection",
					updatedAt: new Date(),
				})
				.where(eq(schedulingSessions.id, session.id));

			await enqueueOutboundMessage({
				conversationId,
				eventId: undefined,
				executor: tx,
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

		// Avança o workflow e envia os slots na mesma transação.
		await db.transaction(async (tx) => {
			await tx
				.update(schedulingSessions)
				.set({
					workflowStage: "awaiting_slot_selection",
					updatedAt: new Date(),
				})
				.where(eq(schedulingSessions.id, session.id));

			await enqueueOutboundMessage({
				conversationId,
				eventId: undefined,
				executor: tx,
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

	// Persiste a preferência e envia os slots do consultor na mesma transação.
	await db.transaction(async (tx) => {
		await tx
			.update(schedulingSessions)
			.set({
				preferredConsultantId: consultantId,
				workflowStage: "awaiting_slot_selection",
				updatedAt: new Date(),
			})
			.where(eq(schedulingSessions.id, session.id));

		await enqueueOutboundMessage({
			conversationId,
			eventId: undefined,
			executor: tx,
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

	// Atualizar workflow stage para awaiting_confirmation e enfileirar o
	// pedido na mesma transação: se o outbox falhar, a sessão continua em
	// awaiting_slot_selection e a nova tentativa refaz o pedido.
	const transitioned = await db.transaction(async (tx) => {
		const [confirmationSession] = await tx
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
			return false;
		}

		await enqueueOutboundMessage({
			conversationId,
			eventId: undefined,
			executor: tx,
			idempotencyKey: runKey,
			leadId: lead.id,
			payload: buttonPayload(confirmation),
		});

		return true;
	});

	if (!transitioned) {
		await markEventProcessed(eventId);
		return { skipped: true, reason: "session_changed_before_confirmation" };
	}

	await markEventProcessed(eventId);
	return { confirmationRequestSent: true };
};

const handleAskSessionChoice: AutonomousTaskHandler = async ({ task }) => {
	const { conversationId, payload: taskPayload } = task;
	const eventId = taskPayload?.eventId as string | undefined;

	const pending = await readPendingSessionChoice(conversationId);
	if (!pending) {
		return { skipped: true, reason: "no_pending_session_choice" };
	}

	const [conversation] = await db
		.select({ id: conversations.id, leadId: conversations.leadId })
		.from(conversations)
		.where(eq(conversations.id, conversationId))
		.limit(1);

	if (!conversation) {
		throw new PermanentAutonomousTaskError("Conversation not found");
	}

	const runKey = `session-choice-question:${conversationId}:${pending.askedAt}`;

	const [existingOutbound] = await db
		.select({ id: outboundMessages.id })
		.from(outboundMessages)
		.where(eq(outboundMessages.idempotencyKey, runKey))
		.limit(1);

	if (existingOutbound && pending.questionMessageId) {
		await markEventProcessed(eventId);
		return { deduplicated: true };
	}

	const [assistantMessage] = await db
		.insert(messages)
		.values({
			content: SESSION_CHOICE_QUESTION_TEXT,
			conversationId,
			role: "assistant",
		})
		.returning({ id: messages.id });

	if (!assistantMessage) {
		throw new Error("Failed to create assistant message");
	}

	await db.transaction(async (tx) => {
		await enqueueOutboundMessage({
			conversationId,
			eventId: undefined,
			executor: tx,
			idempotencyKey: runKey,
			leadId: conversation.leadId,
			messageId: assistantMessage.id,
			payload: buttonPayload({
				body: SESSION_CHOICE_QUESTION_TEXT,
				buttons: [
					{
						id: SESSION_CHOICE_CONTINUE_BUTTON_ID,
						title: SESSION_CHOICE_CONTINUE_BUTTON_TITLE,
					},
					{
						id: SESSION_CHOICE_NEW_BUTTON_ID,
						title: SESSION_CHOICE_NEW_BUTTON_TITLE,
					},
				],
			}),
		});

		await setQuestionMessage({
			conversationId,
			executor: tx,
			questionMessageId: assistantMessage.id,
		});
	});

	await markEventProcessed(eventId);
	return { questionSent: true, assistantMessageId: assistantMessage.id };
};

const handleRemindSessionChoice: AutonomousTaskHandler = async ({ task }) => {
	const { conversationId, payload: taskPayload } = task;
	const eventId = taskPayload?.eventId as string | undefined;

	const pending = await readPendingSessionChoice(conversationId);
	if (!pending) {
		return { skipped: true, reason: "no_pending_session_choice" };
	}

	const [conversation] = await db
		.select({ id: conversations.id, leadId: conversations.leadId })
		.from(conversations)
		.where(eq(conversations.id, conversationId))
		.limit(1);

	if (!conversation) {
		throw new PermanentAutonomousTaskError("Conversation not found");
	}

	const runKey = `session-choice-remind:${conversationId}:${taskPayload?.eventExternalId ?? eventId ?? task.id}`;

	const [existingOutbound] = await db
		.select({ id: outboundMessages.id })
		.from(outboundMessages)
		.where(eq(outboundMessages.idempotencyKey, runKey))
		.limit(1);

	if (existingOutbound) {
		await markEventProcessed(eventId);
		return { deduplicated: true };
	}

	const [assistantMessage] = await db
		.insert(messages)
		.values({
			content: SESSION_CHOICE_REMINDER_TEXT,
			conversationId,
			role: "assistant",
		})
		.returning({ id: messages.id });

	if (!assistantMessage) {
		throw new Error("Failed to create assistant message");
	}

	await db.transaction(async (tx) => {
		await enqueueOutboundMessage({
			conversationId,
			eventId: undefined,
			executor: tx,
			idempotencyKey: runKey,
			leadId: conversation.leadId,
			messageId: assistantMessage.id,
			payload: buttonPayload({
				body: SESSION_CHOICE_REMINDER_TEXT,
				buttons: [
					{
						id: SESSION_CHOICE_CONTINUE_BUTTON_ID,
						title: SESSION_CHOICE_CONTINUE_BUTTON_TITLE,
					},
					{
						id: SESSION_CHOICE_NEW_BUTTON_ID,
						title: SESSION_CHOICE_NEW_BUTTON_TITLE,
					},
				],
			}),
		});
	});

	await markEventProcessed(eventId);
	return { reminded: true, assistantMessageId: assistantMessage.id };
};

async function createInboundTasksForMessages({
	conversationId,
	eventId,
	executor = db,
	messagesList,
}: {
	conversationId: string;
	eventId?: string;
	executor?: Pick<typeof db, "insert">;
	messagesList: Array<{
		createdAt: Date;
		externalId: string | null;
		id: string;
	}>;
}) {
	const batchCutoffAt = new Date(Date.now() + env.MESSAGE_DEBOUNCE_MS);
	for (const message of messagesList) {
		await enqueueTask({
			availableAt: batchCutoffAt,
			conversationId,
			createdAt: message.createdAt,
			executor,
			idempotencyKey: `session-choice-continue:${conversationId}:${message.id}`,
			payload: {
				batchCutoffAt: batchCutoffAt.toISOString(),
				eventExternalId: message.externalId ?? undefined,
				eventId,
				kind: "text",
				source: "session_choice_continue",
			},
			preserveExisting: true,
			taskType: PROCESS_INBOUND_MESSAGE_TASK,
			triggerMessageId: message.id,
		});
	}
}

const handleProcessSessionChoice: AutonomousTaskHandler = async ({ task }) => {
	const { conversationId, payload: taskPayload } = task;
	const eventId = taskPayload?.eventId as string | undefined;
	const buttonId = taskPayload?.buttonId as string | undefined;
	const kind = taskPayload?.kind as string | undefined;
	const externalId = taskPayload?.eventExternalId as string | undefined;

	const pending = await readPendingSessionChoice(conversationId);
	if (!pending) {
		const runKey = `session-choice-reply:${conversationId}:${externalId ?? buttonId ?? task.id}`;
		const [existingOutbound] = await db
			.select({ id: outboundMessages.id })
			.from(outboundMessages)
			.where(eq(outboundMessages.idempotencyKey, runKey))
			.limit(1);
		if (existingOutbound) {
			await markEventProcessed(eventId);
			return { deduplicated: true };
		}
		const [conversation] = await db
			.select({ leadId: conversations.leadId })
			.from(conversations)
			.where(eq(conversations.id, conversationId))
			.limit(1);
		if (conversation) {
			await enqueueOutboundMessage({
				conversationId,
				eventId,
				idempotencyKey: runKey,
				leadId: conversation.leadId,
				payload: { kind: "text", text: SESSION_CHOICE_ALREADY_RECORDED_TEXT },
			});
		}
		await markEventProcessed(eventId);
		return { alreadyRecorded: true };
	}

	if (kind === "invalid" || !buttonId?.startsWith("sessao:")) {
		const runKey = `session-choice-invalid:${conversationId}:${externalId ?? buttonId ?? task.id}`;
		const [existingOutbound] = await db
			.select({ id: outboundMessages.id })
			.from(outboundMessages)
			.where(eq(outboundMessages.idempotencyKey, runKey))
			.limit(1);
		if (existingOutbound) {
			await markEventProcessed(eventId);
			return { deduplicated: true };
		}
		const [conversation] = await db
			.select({ leadId: conversations.leadId })
			.from(conversations)
			.where(eq(conversations.id, conversationId))
			.limit(1);
		if (conversation) {
			await enqueueOutboundMessage({
				conversationId,
				eventId,
				idempotencyKey: runKey,
				leadId: conversation.leadId,
				payload: buttonPayload({
					body: SESSION_CHOICE_PENDING_INVALID_REPLY_TEXT,
					buttons: [
						{
							id: SESSION_CHOICE_CONTINUE_BUTTON_ID,
							title: SESSION_CHOICE_CONTINUE_BUTTON_TITLE,
						},
						{
							id: SESSION_CHOICE_NEW_BUTTON_ID,
							title: SESSION_CHOICE_NEW_BUTTON_TITLE,
						},
					],
				}),
			});
		}
		await markEventProcessed(eventId);
		return { resentQuestion: true };
	}

	const claimed = await claimSessionChoice({
		conversationId,
		state: buttonId === SESSION_CHOICE_NEW_BUTTON_ID ? "new" : "continue",
	});

	if (!claimed) {
		const runKey = `session-choice-reply:${conversationId}:${externalId ?? buttonId ?? task.id}`;
		const [existingOutbound] = await db
			.select({ id: outboundMessages.id })
			.from(outboundMessages)
			.where(eq(outboundMessages.idempotencyKey, runKey))
			.limit(1);
		if (existingOutbound) {
			await markEventProcessed(eventId);
			return { deduplicated: true };
		}
		const [conversation] = await db
			.select({ leadId: conversations.leadId })
			.from(conversations)
			.where(eq(conversations.id, conversationId))
			.limit(1);
		if (conversation) {
			await enqueueOutboundMessage({
				conversationId,
				eventId,
				idempotencyKey: runKey,
				leadId: conversation.leadId,
				payload: { kind: "text", text: SESSION_CHOICE_ALREADY_RECORDED_TEXT },
			});
		}
		await markEventProcessed(eventId);
		return { alreadyRecorded: true };
	}

	if (claimed.state === "continue") {
		await db.transaction(async (tx) => {
			const unprocessed = await tx
				.select({
					createdAt: messages.createdAt,
					externalId: messages.externalId,
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
				.orderBy(asc(messages.createdAt), asc(messages.id));

			if (unprocessed.length > 0) {
				await createInboundTasksForMessages({
					conversationId,
					eventId,
					executor: tx,
					messagesList: unprocessed,
				});
			}
		});

		await markEventProcessed(eventId);
		return { continued: true };
	}

	if (claimed.state === "new") {
		await db.transaction(async (tx) => {
			const [conversation] = await tx
				.select()
				.from(conversations)
				.where(eq(conversations.id, conversationId))
				.for("update")
				.limit(1);

			if (!conversation) {
				throw new PermanentAutonomousTaskError("Conversation not found");
			}

			const [lead] = await tx
				.select()
				.from(leads)
				.where(eq(leads.id, conversation.leadId))
				.for("update")
				.limit(1);

			if (!lead) {
				throw new PermanentAutonomousTaskError("Lead not found");
			}

			const snapshot: SessionChoiceSnapshot = {
				commercialApproach: lead.commercialApproach,
				consortiumType: lead.consortiumType,
				currentSituation: lead.currentSituation,
				interestedInConsultant: lead.interestedInConsultant,
				objective: lead.objective,
				painPoint: lead.painPoint,
				qualifiedAt: lead.qualifiedAt ? lead.qualifiedAt.toISOString() : null,
				status: lead.status,
				urgency: lead.urgency,
			};

			await tx
				.update(leads)
				.set({
					commercialApproach: null,
					consortiumType: null,
					currentSituation: null,
					interestedInConsultant: false,
					objective: null,
					painPoint: null,
					qualifiedAt: null,
					urgency: null,
					updatedAt: new Date(),
				})
				.where(eq(leads.id, lead.id));

			await tx
				.update(autonomousTasks)
				.set({
					payload: sql`${autonomousTasks.payload} || ${JSON.stringify({ snapshot })}::jsonb`,
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(autonomousTasks.conversationId, conversation.id),
						eq(autonomousTasks.taskType, SESSION_CHOICE_STATE_TASK)
					)
				);

			await tx
				.update(conversations)
				.set({ status: "closed", updatedAt: new Date() })
				.where(eq(conversations.id, conversation.id));

			await tx
				.update(schedulingSessions)
				.set({ status: "expired", updatedAt: new Date() })
				.where(
					and(
						eq(schedulingSessions.leadId, lead.id),
						eq(schedulingSessions.status, "active")
					)
				);

			const { conversation: newConversation } =
				await getOrCreateActiveConversation(tx, lead.id);

			await tx
				.update(conversations)
				.set({
					lastCustomerMessageAt: conversation.lastCustomerMessageAt,
					optOutAt: conversation.optOutAt,
					updatedAt: new Date(),
				})
				.where(eq(conversations.id, newConversation.id));

			const unprocessed = await tx
				.select({
					createdAt: messages.createdAt,
					externalId: messages.externalId,
					id: messages.id,
				})
				.from(messages)
				.where(
					and(
						eq(messages.conversationId, conversation.id),
						eq(messages.role, "user"),
						isNull(messages.processedAt)
					)
				)
				.orderBy(asc(messages.createdAt), asc(messages.id));

			if (unprocessed.length > 0) {
				await tx
					.update(messages)
					.set({ conversationId: newConversation.id })
					.where(
						inArray(
							messages.id,
							unprocessed.map((m) => m.id)
						)
					);

				await createInboundTasksForMessages({
					conversationId: newConversation.id,
					eventId,
					executor: tx,
					messagesList: unprocessed,
				});
			}

			const [futureAppointment] = await tx
				.select({ id: appointments.id })
				.from(appointments)
				.where(
					and(
						eq(appointments.leadId, lead.id),
						inArray(appointments.status, ["confirmed", "scheduled"]),
						gt(appointments.startAt, new Date())
					)
				)
				.limit(1);

			if (futureAppointment) {
				if (lead.status !== "scheduled") {
					await tx
						.update(leads)
						.set({ status: "scheduled", updatedAt: new Date() })
						.where(eq(leads.id, lead.id));
				}
			} else if (lead.status === "scheduled") {
				await tx
					.update(leads)
					.set({ status: "new", qualifiedAt: null, updatedAt: new Date() })
					.where(eq(leads.id, lead.id));
			}

			await enqueueOutboundMessage({
				conversationId: newConversation.id,
				eventId,
				executor: tx,
				idempotencyKey: `session-choice-new-confirm:${newConversation.id}:${claimed.resolvedAt ?? Date.now()}`,
				leadId: lead.id,
				payload: {
					kind: "text",
					text: SESSION_CHOICE_NEW_CONVERSATION_CONFIRMATION_TEXT,
				},
			});
		});

		await markEventProcessed(eventId);
		return { newConversation: true };
	}

	await markEventProcessed(eventId);
	return { processed: true };
};

export const PROCESS_INBOUND_MESSAGE_TASK = "process_inbound_message";
export const PROCESS_BUTTON_REPLY_TASK = "process_button_reply";
export const SEND_CONSULTANT_PREFERENCE_QUESTION_TASK =
	"send_consultant_preference_question";
export const PROCESS_CONSULTANT_PREFERENCE_REPLY_TASK =
	"process_consultant_preference_reply";
export const PROCESS_CONSULTANT_SELECTION_TASK = "process_consultant_selection";
export const SEND_CONFIRMATION_REQUEST_TASK = "send_confirmation_request";
export const SESSION_CHOICE_STATE_TASK = "session_choice_state";
export const ASK_SESSION_CHOICE_TASK = "ask_session_choice";
export const REMIND_SESSION_CHOICE_TASK = "remind_session_choice";
export const PROCESS_SESSION_CHOICE_TASK = "process_session_choice";

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
		[ASK_SESSION_CHOICE_TASK]: handleAskSessionChoice,
		[REMIND_SESSION_CHOICE_TASK]: handleRemindSessionChoice,
		[PROCESS_SESSION_CHOICE_TASK]: handleProcessSessionChoice,
	};
}
