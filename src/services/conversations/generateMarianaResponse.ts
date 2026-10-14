/** biome-ignore-all lint/style/useFilenamingConvention: <> */
/** biome-ignore-all lint/correctness/noUndeclaredVariables: <> */
/** biome-ignore-all lint/correctness/noUnusedVariables: <> */
/** biome-ignore-all assist/source/useSortedKeys: <> */

import type { InferInsertModel, InferSelectModel, SQL } from "drizzle-orm";
import { and, asc, eq, inArray, lt, lte, or } from "drizzle-orm";

import {
	type GenerateMarianaReplyResult,
	generateMarianaReply,
} from "../../ai/agent";
import type { BusinessProfile } from "../../ai/business-profile";
import { COMMERCIAL_HANDOFF } from "../../ai/knowledge/commercial-policy";
import { db } from "../../db/connections";
import { appointments, conversations, leads, messages } from "../../db/schema";
import {
	type ExecuteNextActionResult,
	executeNextAction,
	type NextAction,
} from "../agent/execute-next-action";
import { CONFIRMED_APPOINTMENT_STATUSES } from "../appointments/appointment-status";
import type { ConsultantAvailableSlot } from "../calendar/consultant-availability";
import { SchedulingAvailabilityService } from "../calendar/scheduling-availability";
import {
	type PersistSchedulingOfferResult,
	SchedulingOfferService,
} from "../calendar/scheduling-offer-service";
import type { LeadStatus } from "../leads/lead-status";
import {
	buildQualificationFallbackReply,
	DEFAULT_FALLBACK_REPLY,
	getMissingQualificationFields,
	mergeQualificationInput,
} from "../leads/qualification-gaps";
import { updateLeadFromAgent } from "../leads/update-lead-from-agent";

type PersistLeadTransactionValues = Partial<InferInsertModel<typeof leads>> & {
	updatedAt: Date;
};

export interface GenerateMarianaResponseParams {
	businessProfile?: BusinessProfile;
	currentMessages: string[];
	generateMarianaReplyFn?: typeof generateMarianaReply;
	leadId: string;
	messageCutoff?: Date;
	messageIds?: string[];
	persistUserMessage?: boolean;
	schedulingAvailabilityService?: SchedulingAvailabilityService;
	schedulingOfferService?: SchedulingOfferService;
}

export interface GenerateMarianaResponseResult {
	actionResult: Awaited<ReturnType<typeof executeNextAction>>;
	assistantMessage?: InferSelectModel<typeof messages>;
	metadata: GenerateMarianaReplyResult["metadata"];
	result: GenerateMarianaReplyResult["result"];
	schedulingOffer?: PersistSchedulingOfferResult;
}

export function buildMessageHistoryCondition({
	conversationId,
	messageCutoff,
	messageIds,
}: {
	conversationId: string;
	messageCutoff?: Date;
	messageIds?: string[];
}): SQL {
	const conversationCondition = eq(messages.conversationId, conversationId);

	if (!messageCutoff) {
		return conversationCondition;
	}

	const releasedMessagesCondition = messageIds?.length
		? inArray(messages.id, messageIds)
		: undefined;
	const cutoffCondition = releasedMessagesCondition
		? lt(messages.createdAt, messageCutoff)
		: lte(messages.createdAt, messageCutoff);

	return and(
		conversationCondition,
		releasedMessagesCondition
			? or(cutoffCondition, releasedMessagesCondition)
			: cutoffCondition
	) as SQL;
}

async function persistLeadUpdate({
	leadId,
	values,
	tx,
}: {
	leadId: string;
	values: PersistLeadTransactionValues & { status: LeadStatus };
	tx: Parameters<Parameters<typeof db.transaction>[0]>[0];
}) {
	const [updatedLead] = await tx
		.update(leads)
		.set({
			...(values.birthDate === undefined
				? {}
				: { birthDate: values.birthDate }),
			...(values.commercialApproach === undefined
				? {}
				: { commercialApproach: values.commercialApproach }),
			...(values.consortiumType === undefined
				? {}
				: { consortiumType: values.consortiumType }),
			...(values.currentSituation === undefined
				? {}
				: { currentSituation: values.currentSituation }),
			...(values.interestedInConsultant === undefined
				? {}
				: { interestedInConsultant: values.interestedInConsultant }),
			...(values.objective === undefined
				? {}
				: { objective: values.objective }),
			...(values.painPoint === undefined
				? {}
				: { painPoint: values.painPoint }),
			...(values.qualifiedAt === undefined
				? {}
				: { qualifiedAt: values.qualifiedAt }),
			...(values.urgency === undefined ? {} : { urgency: values.urgency }),
			status: values.status,
			updatedAt: values.updatedAt,
		})
		.where(eq(leads.id, leadId))
		.returning();

	if (!updatedLead) {
		throw new Error("Lead not found");
	}

	return updatedLead;
}

function formatSchedulingOffer(slots: ConsultantAvailableSlot[]): string {
	if (slots.length === 0) {
		return "No momento, não encontrei horários disponíveis nos próximos 5 dias.";
	}

	const dateFormatter = new Intl.DateTimeFormat("pt-BR", {
		day: "2-digit",
		month: "2-digit",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		timeZone: "America/Sao_Paulo",
	});

	const formattedSlots = slots
		.map(
			(slot, index) =>
				`${index + 1}. ${dateFormatter.format(slot.start).replace(",", " às")}`
		)
		.join("\n");

	return [
		"Tenho estes horários disponíveis:",
		"",
		formattedSlots,
		"",
		"Qual desses horários você prefere?",
	].join("\n");
}

const SCHEDULING_COMMITMENT_PATTERNS = [
	/\b(?:vou|vamos|posso|podemos|irei|consigo)\b.{0,60}\b(?:agendar|marcar|reservar)\b/,
	/\b(?:vou|vamos|posso|podemos|irei|consigo)\b.{0,60}\b(?:verificar|consultar|checar|buscar|passar|enviar|mostrar)\b.{0,40}\b(?:horarios?|disponibilidade|agenda|vagas?)\b/,
	/\b(?:tenho|encontrei|separei|reservei|verifiquei)\b.{0,30}\b(?:horarios?|disponibilidade|vagas?)\b/,
	/\b(?:horarios?|vagas?)\s+(?:disponiveis|livres)\b/,
	/\b(?:agendado|marcado|reservado)\b/,
	/\b(?:segue|aqui estao)\b.{0,40}\b(?:horarios?|disponibilidade|agenda|vagas?)\b/,
];

function requestsSchedulingAction(nextAction: NextAction): boolean {
	return (
		nextAction === "offer_meeting" ||
		nextAction === "offer_appointment" ||
		nextAction === "schedule_meeting" ||
		nextAction === "wait_for_schedule"
	);
}

function hasSchedulingCommitment(reply: string): boolean {
	const normalizedReply = reply
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase();

	return SCHEDULING_COMMITMENT_PATTERNS.some((pattern) =>
		pattern.test(normalizedReply)
	);
}

export async function persistAuthorizedAssistantReply<AssistantMessage>({
	actionResult,
	fallbackReply,
	requestedAction,
	persistAssistantMessage,
	reply,
}: {
	actionResult: ExecuteNextActionResult;
	/** Pergunta usada quando a resposta do modelo é bloqueada. */
	fallbackReply?: string;
	persistAssistantMessage: (content: string) => Promise<AssistantMessage>;
	requestedAction: NextAction;
	reply: string;
}): Promise<{
	actionResult: ExecuteNextActionResult;
	assistantMessage: AssistantMessage;
	reply: string;
	shouldOfferSlots: boolean;
}> {
	const shouldOfferSlots =
		actionResult.action === "offer_meeting" &&
		actionResult.status === "executed";
	const schedulingAuthorized =
		shouldOfferSlots ||
		(actionResult.action === "schedule_meeting" &&
			actionResult.status === "pending");
	let authorizedReply = reply;

	if (
		!schedulingAuthorized &&
		(requestsSchedulingAction(requestedAction) ||
			hasSchedulingCommitment(reply))
	) {
		authorizedReply =
			actionResult.action === "request_consultant"
				? COMMERCIAL_HANDOFF
				: fallbackReply?.trim() || DEFAULT_FALLBACK_REPLY;
	}

	const assistantMessage = await persistAssistantMessage(authorizedReply);

	return {
		actionResult,
		assistantMessage,
		reply: authorizedReply,
		shouldOfferSlots,
	};
}

export async function runSchedulingOfferIfAuthorized<Result>(
	shouldOfferSlots: boolean,
	runSchedulingOffer: () => Promise<Result>
): Promise<Result | undefined> {
	if (!shouldOfferSlots) {
		return undefined;
	}

	return await runSchedulingOffer();
}

export async function generateMarianaResponse({
	businessProfile,
	leadId,
	messageCutoff,
	messageIds,
	currentMessages,
	persistUserMessage = true,
	schedulingAvailabilityService = new SchedulingAvailabilityService(),
	schedulingOfferService = new SchedulingOfferService(),
	generateMarianaReplyFn = generateMarianaReply,
}: GenerateMarianaResponseParams): Promise<GenerateMarianaResponseResult> {
	// 1. Busca o lead
	const [lead] = await db
		.select()
		.from(leads)
		.where(eq(leads.id, leadId))
		.limit(1);

	if (!lead) {
		throw new Error("Lead not found");
	}

	// 2. Busca a conversation ativa
	const [activeConversation] = await db
		.select()
		.from(conversations)
		.where(
			and(eq(conversations.leadId, leadId), eq(conversations.status, "active"))
		)
		.limit(1);

	if (!activeConversation) {
		throw new Error("Active conversation not found");
	}

	// 3. Salva a mensagem do usuário quando ela ainda não foi persistida
	let effectiveMessageIds = messageIds ?? [];
	let effectiveMessageCutoff = messageCutoff;

	if (persistUserMessage) {
		const insertedMessages = await db
			.insert(messages)
			.values(
				currentMessages.map((content) => ({
					content,
					conversationId: activeConversation.id,
					role: "user" as const,
				}))
			)
			.returning({
				id: messages.id,
				createdAt: messages.createdAt,
			});

		effectiveMessageIds = insertedMessages.map((message) => message.id);

		effectiveMessageCutoff = insertedMessages.reduce(
			(latest, message) =>
				message.createdAt > latest ? message.createdAt : latest,
			insertedMessages[0]?.createdAt ?? new Date()
		);
	}

	// 4. Busca o histórico
	const history = await db
		.select()
		.from(messages)
		.where(
			buildMessageHistoryCondition({
				conversationId: activeConversation.id,
				messageCutoff: effectiveMessageCutoff,
				messageIds: effectiveMessageIds,
			})
		)
		.orderBy(asc(messages.createdAt));

	const currentMessageIdSet = new Set(effectiveMessageIds);

	const previousHistory = history.filter(
		(message) => !currentMessageIdSet.has(message.id)
	);

	const currentBlockMessages = history.filter((message) =>
		currentMessageIdSet.has(message.id)
	);

	// 5. Contexto do lead
	const qualificationInput = {
		birthDate: lead.birthDate,
		consortiumType: lead.consortiumType,
		currentSituation: lead.currentSituation,
		interestedInConsultant: lead.interestedInConsultant,
		objective: lead.objective,
		painPoint: lead.painPoint,
	};
	const isFirstContact = !previousHistory.some(
		(message) => message.role === "assistant"
	);
	const agentLead = {
		commercialApproach: lead.commercialApproach,
		consortiumType: lead.consortiumType ?? "",
		currentSituation: lead.currentSituation,
		name: lead.name,
		objective: lead.objective ?? "",
		painPoint: lead.painPoint,
		status: lead.status,
		urgency: lead.urgency,
	};

	// 6. Converte histórico
	const agentHistory = previousHistory.map((message) => ({
		content: message.content,
		createdAt: message.createdAt,
		role: message.role,
	}));

	const agentCurrentMessages = currentBlockMessages.map((message) => ({
		content: message.content,
		createdAt: message.createdAt,
		role: message.role,
	}));

	// 7. Chama a IA
	const response = await generateMarianaReplyFn({
		businessProfile,
		currentMessages: agentCurrentMessages,
		conversationContext: {
			isFirstContact,
			missingQualification: getMissingQualificationFields(qualificationInput),
		},
		history: agentHistory,
		lead: agentLead,
	});

	// Pergunta de fallback considera o que o modelo acabou de extrair nesta rodada.
	const fallbackReply = buildQualificationFallbackReply(
		getMissingQualificationFields(
			mergeQualificationInput(qualificationInput, response.result.leadUpdate)
		)
	);

	// 8. Valida regra de negócio antes de persistir qualquer mudança de status
	const [existingAppointment] = await db
		.select({ id: appointments.id })
		.from(appointments)
		.where(
			and(
				eq(appointments.leadId, leadId),
				inArray(appointments.status, CONFIRMED_APPOINTMENT_STATUSES)
			)
		)
		.limit(1);

	const appointmentCreated = Boolean(existingAppointment);

	// 9. Salva resposta da Mariana e aplica a atualização do lead apenas se a transição for permitida
	const actionResult = await db.transaction(async (tx) => {
		let updatedLeadStatus: LeadStatus = lead.status as LeadStatus;

		await updateLeadFromAgent({
			appointmentCreated,
			currentStatus: lead.status,
			existingLead: {
				birthDate: lead.birthDate,
				consortiumType: lead.consortiumType,
				currentSituation: lead.currentSituation,
				interestedInConsultant: lead.interestedInConsultant,
				objective: lead.objective,
				painPoint: lead.painPoint,
			},
			leadId,
			leadUpdate: {
				...response.result.leadUpdate,
				birthDate:
					response.result.leadUpdate.birthDate === undefined ||
					response.result.leadUpdate.birthDate === null
						? response.result.leadUpdate.birthDate
						: new Date(response.result.leadUpdate.birthDate),
			},
			persistLead: async ({ leadId: targetLeadId, values }) =>
				persistLeadUpdate({
					leadId: targetLeadId,
					tx,
					values,
				}),
			onPersistedStatus: (status) => {
				updatedLeadStatus = status;
			},
		});

		const nextActionResult = await executeNextAction({
			conversationId: activeConversation.id,
			currentStatus: updatedLeadStatus,
			currentMessages,
			leadId,
			nextAction: response.result.nextAction,
			persistConversationStatus: async ({
				conversationId: targetConversationId,
				status,
				updatedAt,
			}) => {
				const [updatedConversation] = await tx
					.update(conversations)
					.set({
						status,
						updatedAt,
					})
					.where(eq(conversations.id, targetConversationId))
					.returning();

				if (!updatedConversation) {
					throw new Error("Conversation not found");
				}

				return updatedConversation;
			},
		});

		const preparedResponse = await persistAuthorizedAssistantReply({
			actionResult: nextActionResult,
			fallbackReply,
			persistAssistantMessage: async (content) => {
				const [assistantMessage] = await tx
					.insert(messages)
					.values({
						content,
						conversationId: activeConversation.id,
						role: "assistant",
					})
					.returning();

				if (!assistantMessage) {
					throw new Error("Assistant message not found");
				}

				return assistantMessage;
			},
			requestedAction: response.result.nextAction,
			reply: response.result.reply,
		});

		await tx
			.update(conversations)
			.set({
				updatedAt: new Date(),
			})
			.where(eq(conversations.id, activeConversation.id));

		return preparedResponse;
	});

	let finalReply = actionResult.reply;
	let finalAssistantMessage = actionResult.assistantMessage;
	let schedulingOffer: PersistSchedulingOfferResult | undefined;

	await runSchedulingOfferIfAuthorized(
		actionResult.shouldOfferSlots,
		async () => {
			const timeMin = new Date();
			const timeMax = new Date(timeMin);

			timeMax.setDate(timeMax.getDate() + 5);

			const slots = await schedulingAvailabilityService.getAvailableSlots({
				leadId,
				timeMin,
				timeMax,
			});

			const offeredSlots = slots.slice(0, 3);

			finalReply = formatSchedulingOffer(offeredSlots);

			if (!actionResult.assistantMessage) {
				throw new Error("Assistant message not found");
			}

			if (offeredSlots.length > 0) {
				schedulingOffer = await schedulingOfferService.persistOffer({
					conversationId: activeConversation.id,
					finalReply,
					leadId,
					messageId: actionResult.assistantMessage.id,
					offeredSlots,
				});

				finalAssistantMessage = schedulingOffer.updatedAssistantMessage;

				if (schedulingOffer.slots.length > 0) {
					// Uma única opção segue direto para a confirmação já persistida.
					await schedulingOfferService.enqueueConsultantPreferenceQuestion({
						conversationId: activeConversation.id,
						schedulingSessionId: schedulingOffer.session.id,
						eventId: schedulingOffer.session.id,
					});
				}
			} else {
				const [updatedAssistantMessage] = await db
					.update(messages)
					.set({
						content: finalReply,
					})
					.where(eq(messages.id, actionResult.assistantMessage.id))
					.returning();

				if (!updatedAssistantMessage) {
					throw new Error("Assistant message not found");
				}

				finalAssistantMessage = updatedAssistantMessage;
			}
		}
	);

	return {
		actionResult: actionResult.actionResult,
		assistantMessage: finalAssistantMessage,
		metadata: response.metadata,
		result: {
			...response.result,
			reply: finalReply,
		},
		schedulingOffer,
	};
}
