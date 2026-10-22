/** biome-ignore-all lint/style/useFilenamingConvention: <> */
/** biome-ignore-all lint/correctness/noUndeclaredVariables: <> */
/** biome-ignore-all lint/correctness/noUnusedVariables: <> */
/** biome-ignore-all assist/source/useSortedKeys: <> */
/**
 * biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: o try/catch
 * do turno inteiro (decisão P-4 do plano) soma 3 pontos a uma função que já
 * estava no limite de 20. Dividir `generateMarianaResponse` é refatoração de
 * comportamento, fora do escopo deste passo.
 */

import type { InferInsertModel, InferSelectModel, SQL } from "drizzle-orm";
import { and, asc, eq, gt, inArray, lt, lte, or } from "drizzle-orm";

import {
	type GenerateMarianaReplyResult,
	generateMarianaReply,
	type TurnRewritesCarrier,
} from "../../ai/agent";
import type { BusinessProfile } from "../../ai/business-profile";
import { COMMERCIAL_HANDOFF } from "../../ai/knowledge/commercial-policy";
import { ModelUnavailableError } from "../../ai/model-errors";
import { db } from "../../db/connections";
import {
	appointments,
	conversations,
	leads,
	messages,
	schedulingSessions,
} from "../../db/schema";
import { env } from "../../env";
import {
	buildRewriteRecord,
	hashText,
	isPureBackendText,
	logTurnTrace,
	type RewriteLayer,
	type RewriteRecord,
	type TurnOutcome,
} from "../../lib/turn-trace";
import {
	type ExecuteNextActionResult,
	executeNextAction,
	hasCurrentSchedulingIntent,
	type NextAction,
} from "../agent/execute-next-action";
import { CONFIRMED_APPOINTMENT_STATUSES } from "../appointments/appointment-status";
import type { ConsultantAvailableSlot } from "../calendar/consultant-availability";
import { SchedulingAvailabilityService } from "../calendar/scheduling-availability";
import {
	type PersistSchedulingOfferResult,
	SchedulingOfferService,
} from "../calendar/scheduling-offer-service";
import { isLeadQualified } from "../leads/lead-qualification";
import type { LeadStatus } from "../leads/lead-status";
import {
	DEFAULT_FALLBACK_REPLY,
	mergeQualificationInput,
} from "../leads/qualification-gaps";
import { updateLeadFromAgent } from "../leads/update-lead-from-agent";
import {
	composeStageReply,
	composeStageReplyWithTrace,
	computeConversationStage,
	findAskedQuestion,
	isAlreadySaidComplaint,
	isNameKnown,
	reconcileLeadUpdate,
	type StageLead,
} from "./conversation-stage";
import { acceptsPendingOffer, detectPendingOffer } from "./pending-offer";

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
	/** Id da task âncora do turno; vai para o rastro como `turnId`. */
	traceTurnId?: string;
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
	/** L5 ou L10, quando a autorização trocou o texto do modelo. */
	rewrites: RewriteRecord[];
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
	const rewrites: RewriteRecord[] = [];

	if (
		!schedulingAuthorized &&
		(requestsSchedulingAction(requestedAction) ||
			hasSchedulingCommitment(reply))
	) {
		const isHandoff = actionResult.action === "request_consultant";

		authorizedReply = isHandoff
			? COMMERCIAL_HANDOFF
			: fallbackReply?.trim() || DEFAULT_FALLBACK_REPLY;

		if (authorizedReply !== reply) {
			rewrites.push(
				buildRewriteRecord(
					isHandoff
						? "L5_request_consultant_override"
						: "L10_unauthorized_scheduling",
					reply,
					authorizedReply
				)
			);
		}
	}

	const assistantMessage = await persistAssistantMessage(authorizedReply);

	return {
		actionResult,
		assistantMessage,
		reply: authorizedReply,
		rewrites,
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

interface TurnTraceContext {
	actionBlockedReason: string | null;
	conversationId: string;
	executedAction: string;
	guardrailLayer: RewriteLayer | null;
	leadId: string;
	metadata?: Partial<GenerateMarianaReplyResult["metadata"]>;
	outcome: TurnOutcome;
	postTurnStage: string;
	questionKey: string | null;
	rawReplyText: string | null;
	requestedNextAction: string;
	/** `null` = o produtor não reportou; `[]` = nenhuma camada mudou o texto. */
	rewrites: RewriteRecord[] | null;
	sentReplyText: string | null;
	stage: string;
	turnId: string;
}

/**
 * Linha de um turno que lançou fora dos guardrails (decisão P-4). O modelo
 * pode ter respondido antes da falha, então o que existe dele é reportado e o
 * resto fica `null` — nada é inventado.
 */
function emitFailureTrace(context: {
	conversationId: string;
	error: unknown;
	leadId: string;
	postTurnStage: string;
	questionKey: string | null;
	response: GenerateMarianaReplyResult | undefined;
	stage: string;
	turnId: string;
}): void {
	const { error, response } = context;

	emitTurnTrace({
		actionBlockedReason: null,
		conversationId: context.conversationId,
		executedAction: "none",
		guardrailLayer: null,
		leadId: context.leadId,
		metadata: response?.metadata,
		// Falha do modelo tem desfecho próprio; o resto é `turn_error`.
		outcome:
			error instanceof ModelUnavailableError ? "model_error" : "turn_error",
		postTurnStage: context.postTurnStage,
		questionKey: context.questionKey,
		rawReplyText: response?.result.reply ?? null,
		requestedNextAction:
			response?.metadata.requestedNextAction ??
			response?.result.nextAction ??
			"unknown",
		rewrites: response?.metadata.rewrites ?? null,
		sentReplyText: null,
		stage: context.stage,
		turnId: context.turnId,
	});
}

/** O motivo do bloqueio existe só na variante rebaixada (decisão P-5). */
function blockedReasonOf(result: ExecuteNextActionResult): string | null {
	return "blockedReason" in result ? (result.blockedReason ?? null) : null;
}

// Uma linha por turno. Só comprimentos e hashes de texto da própria Mariana:
// nada do que o cliente escreveu, e nunca o telefone.
function emitTurnTrace(context: TurnTraceContext): void {
	const { metadata, rawReplyText, rewrites, sentReplyText } = context;
	const usage = metadata?.usage ?? null;

	logTurnTrace({
		actionBlockedReason: context.actionBlockedReason,
		commercialAccessLevel: metadata?.commercialAccessLevel ?? null,
		conversationId: context.conversationId,
		executedAction: context.executedAction,
		finishReason: metadata?.finishReason ?? null,
		guardrailLayer: context.guardrailLayer,
		// C-2: nenhuma medição não é latência zero.
		latencyMs: metadata?.latencyMs ?? null,
		leadId: context.leadId,
		maxOutputTokens: env.GEMINI_MAX_OUTPUT_TOKENS,
		model: env.GEMINI_MODEL,
		modelVersionReturned: metadata?.modelVersionReturned ?? null,
		outcome: context.outcome,
		postTurnStage: context.postTurnStage,
		// Indecidível quando ninguém reportou as camadas: nunca `false` por omissão.
		pureBackendText:
			rewrites === null || rawReplyText === null || sentReplyText === null
				? null
				: isPureBackendText(rawReplyText, sentReplyText, rewrites),
		questionKey: context.questionKey,
		// C-3: sem relato do produtor o hash "cru" seria o texto pós-L1/L3.
		// Um hash ausente não engana; um hash mal rotulado engana.
		rawReplyHash: metadata?.rawReplyHash ?? null,
		rawReplyLength: metadata?.rawReplyLength ?? null,
		requestedNextAction: context.requestedNextAction,
		rewrites,
		rewritesReported: rewrites !== null,
		sentReplyHash: sentReplyText === null ? null : hashText(sentReplyText),
		sentReplyLength: sentReplyText?.length ?? null,
		stage: context.stage,
		temperature: env.GEMINI_TEMPERATURE,
		thinkingLevel: env.GEMINI_THINKING_LEVEL,
		turnId: context.turnId,
		usage: {
			candidatesTokens: usage?.candidatesTokenCount ?? null,
			promptTokens: usage?.promptTokenCount ?? null,
			thoughtsTokens: usage?.thoughtsTokenCount ?? null,
			totalTokens: usage?.totalTokenCount ?? null,
		},
	});
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
	traceTurnId,
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

	// 5. Etapa da conversa calculada pelo backend (lead persistido + histórico)
	const qualificationInput = {
		birthDate: lead.birthDate,
		consortiumType: lead.consortiumType,
		currentSituation: lead.currentSituation,
		interestedInConsultant: lead.interestedInConsultant,
		objective: lead.objective,
		painPoint: lead.painPoint,
	};
	const assistantHistory = previousHistory
		.filter((message) => message.role === "assistant")
		.map((message) => message.content);
	const previousAssistantMessage = assistantHistory.at(-1) ?? null;
	const isFirstContact = assistantHistory.length === 0;
	// Marcador sem migração: texto exato do backend na mensagem anterior.
	const pendingOffer = detectPendingOffer(previousAssistantMessage);
	const lastAskedQuestion = previousAssistantMessage
		? findAskedQuestion(previousAssistantMessage)
		: null;
	const [activeSchedulingSession] = await db
		.select({ id: schedulingSessions.id })
		.from(schedulingSessions)
		.where(
			and(
				eq(schedulingSessions.leadId, leadId),
				eq(schedulingSessions.status, "active"),
				gt(schedulingSessions.expiresAt, new Date())
			)
		)
		.limit(1);
	const hasActiveSchedulingSession = Boolean(activeSchedulingSession);
	const stageLead: StageLead = {
		currentSituation: lead.currentSituation,
		interestedInConsultant: lead.interestedInConsultant,
		name: lead.name,
		objective: lead.objective,
		painPoint: lead.painPoint,
		phone: lead.phone,
		status: lead.status,
	};
	const turnStage = computeConversationStage({
		assistantHistory,
		hasActiveSchedulingSession,
		lead: stageLead,
	});
	const agentLead = {
		commercialApproach: lead.commercialApproach,
		consortiumType: lead.consortiumType ?? "",
		currentSituation: lead.currentSituation,
		name: isNameKnown(lead.name, lead.phone) ? lead.name : "não informado",
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

	const turnId = traceTurnId ?? activeConversation.id;
	const traceBase = {
		conversationId: activeConversation.id,
		leadId,
		stage: turnStage.stage,
	};
	// P-4: o turno inteiro fica dentro do try. Um turno que morre depois da
	// chamada ao modelo (calendário, banco, transação) emitia zero linhas.
	let traceEmitted = false;
	let turnResponse: GenerateMarianaReplyResult | undefined;

	try {
		// 7. Chama a IA: ela só escreve o texto; etapa e pergunta são do backend.
		const response = await callModelForTurn({
			businessProfile,
			currentMessages: agentCurrentMessages,
			conversationContext: {
				doNotAsk: turnStage.doNotAsk,
				isFirstContact,
				pendingOffer,
				question: turnStage.question,
				stage: turnStage.stage,
			},
			history: agentHistory,
			lead: agentLead,
		});

		async function callModelForTurn(
			params: Parameters<typeof generateMarianaReplyFn>[0]
		) {
			try {
				turnResponse = await generateMarianaReplyFn(params);

				return turnResponse;
			} catch (error) {
				const carrier = error as Error & TurnRewritesCarrier;

				// L2/L4 lançam por projeto. O comportamento não muda: o turno só
				// passa a ser visível, e com o id da camada que lançou (P-1).
				if (carrier.turnGuardrailLayer) {
					traceEmitted = true;
					emitTurnTrace({
						...traceBase,
						actionBlockedReason: null,
						executedAction: "none",
						guardrailLayer: carrier.turnGuardrailLayer,
						outcome: "guardrail_throw",
						postTurnStage: turnStage.stage,
						questionKey: turnStage.questionKey,
						rawReplyText: null,
						requestedNextAction: "unknown",
						rewrites: carrier.turnRewrites ?? null,
						sentReplyText: null,
						turnId,
					});
				}

				throw error;
			}
		}

		// Extração validada pelo backend; status e interesse no consultor são
		// decididos aqui, nunca pelo modelo.
		const reconciledUpdate = reconcileLeadUpdate({
			currentMessages,
			lastAskedQuestion,
			lead: stageLead,
			leadUpdate: response.result.leadUpdate,
		});
		const mergedObjective = reconciledUpdate.objective ?? lead.objective;
		const acceptedOffer = acceptsPendingOffer({
			currentMessages,
			pendingOffer,
		});
		const reasonAnswered =
			pendingOffer === "consultant_reason" &&
			typeof mergedObjective === "string" &&
			mergedObjective.trim().length > 0;
		const wantsConsultant =
			acceptedOffer ||
			reasonAnswered ||
			hasCurrentSchedulingIntent(currentMessages);
		const interestedInConsultantUpdate = wantsConsultant ? true : undefined;
		const baseStatus = (
			lead.status === "new" ? "qualifying" : lead.status
		) as LeadStatus;
		const computedStatus: LeadStatus =
			baseStatus === "qualifying" &&
			isLeadQualified(
				mergeQualificationInput(qualificationInput, {
					...reconciledUpdate,
					interestedInConsultant: interestedInConsultantUpdate,
				})
			)
				? "qualified"
				: baseStatus;

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
			let updatedLeadStatus: LeadStatus = baseStatus;

			await updateLeadFromAgent({
				appointmentCreated,
				currentStatus: baseStatus,
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
					...reconciledUpdate,
					birthDate:
						reconciledUpdate.birthDate === undefined ||
						reconciledUpdate.birthDate === null
							? reconciledUpdate.birthDate
							: new Date(reconciledUpdate.birthDate),
					interestedInConsultant: interestedInConsultantUpdate,
					status: computedStatus,
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

			if (reconciledUpdate.name) {
				await tx
					.update(leads)
					.set({ name: reconciledUpdate.name })
					.where(eq(leads.id, leadId));
			}

			const nextActionResult = await executeNextAction({
				acceptedPendingOffer: acceptedOffer || reasonAnswered,
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

			// A pergunta do turno é recalculada com o que acabou de ser extraído.
			const postTurnStage = computeConversationStage({
				assistantHistory,
				hasActiveSchedulingSession,
				lead: {
					...stageLead,
					currentSituation:
						reconciledUpdate.currentSituation ?? lead.currentSituation,
					interestedInConsultant:
						interestedInConsultantUpdate ?? lead.interestedInConsultant,
					name: reconciledUpdate.name ?? lead.name,
					objective: mergedObjective,
					painPoint: reconciledUpdate.painPoint ?? lead.painPoint,
					status: updatedLeadStatus,
				},
			});
			const stageReplyInput = {
				apologize: isAlreadySaidComplaint(currentMessages),
				isFirstContact,
				previousAssistantMessage,
				question: postTurnStage.question,
			};
			const composed =
				nextActionResult.action === "request_consultant"
					? {
							reply: COMMERCIAL_HANDOFF,
							// L5: o repasse comercial substitui o texto do modelo antes
							// de qualquer composição de estágio.
							rewrites:
								COMMERCIAL_HANDOFF === response.result.reply
									? []
									: [
											buildRewriteRecord(
												"L5_request_consultant_override",
												response.result.reply,
												COMMERCIAL_HANDOFF
											),
										],
						}
					: composeStageReplyWithTrace({
							...stageReplyInput,
							modelReply: response.result.reply,
						});
			const composedReply = composed.reply;
			const fallbackReply = composeStageReply({
				...stageReplyInput,
				modelReply: "",
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
				reply: composedReply,
			});

			await tx
				.update(conversations)
				.set({
					updatedAt: new Date(),
				})
				.where(eq(conversations.id, activeConversation.id));

			return {
				...preparedResponse,
				postTurnStage: postTurnStage.stage,
				questionKey: postTurnStage.questionKey,
				rewrites: [
					...composed.rewrites,
					...preparedResponse.rewrites,
				] as RewriteRecord[],
			};
		});

		let finalReply = actionResult.reply;
		let finalAssistantMessage = actionResult.assistantMessage;
		let schedulingOffer: PersistSchedulingOfferResult | undefined;
		const turnRewrites: RewriteRecord[] = [...actionResult.rewrites];

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
				const replyBeforeOffer = finalReply;

				finalReply = formatSchedulingOffer(offeredSlots);

				// L11: a oferta de horários é montada pelo backend e troca o texto.
				if (finalReply !== replyBeforeOffer) {
					turnRewrites.push(
						buildRewriteRecord(
							"L11_slot_offer_replaced",
							replyBeforeOffer,
							finalReply
						)
					);
				}

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

		traceEmitted = true;
		emitTurnTrace({
			...traceBase,
			actionBlockedReason: blockedReasonOf(actionResult.actionResult),
			executedAction: actionResult.actionResult.action,
			guardrailLayer: null,
			metadata: response.metadata,
			outcome: "replied",
			postTurnStage: actionResult.postTurnStage,
			questionKey: actionResult.questionKey,
			rawReplyText: response.result.reply,
			requestedNextAction:
				response.metadata.requestedNextAction ?? response.result.nextAction,
			// P-2: sem relato do produtor o rastro diz `null`, nunca `[]`.
			rewrites: response.metadata.rewrites
				? [...response.metadata.rewrites, ...turnRewrites]
				: null,
			sentReplyText: finalReply,
			turnId,
		});

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
	} catch (error) {
		// Relança sem tocar: a task falha exatamente como hoje. O que muda é
		// que o turno deixa de ser invisível.
		if (!traceEmitted) {
			emitFailureTrace({
				...traceBase,
				error,
				postTurnStage: turnStage.stage,
				questionKey: turnStage.questionKey,
				response: turnResponse,
				turnId,
			});
		}

		throw error;
	}
}
