/** biome-ignore-all lint/style/useFilenamingConvention: <> */

import { eq } from "drizzle-orm";

import type { MarianaResponse } from "../../ai/schemas/mariana-response-schema";
import { db } from "../../db/connections";
import { conversations } from "../../db/schema";

export const NEXT_ACTIONS = [
	"continue_qualification",
	"offer_meeting",
	"schedule_meeting",
	"close",
	"answer_basic_question",
	"answer_with_more_detail",
	"ask_next_qualification_question",
	"request_consultant",
	"offer_appointment",
	"wait_for_schedule",
	"close_conversation",
	"reject_out_of_scope",
] as const;

export type MarianaNextAction =
	| "answer_basic_question"
	| "answer_with_more_detail"
	| "ask_next_qualification_question"
	| "request_consultant"
	| "offer_appointment"
	| "wait_for_schedule"
	| "close_conversation"
	| "reject_out_of_scope"
	| MarianaResponse["nextAction"];

export type NextAction = MarianaNextAction;

const ACTION_ALIASES: Record<MarianaNextAction, MarianaResponse["nextAction"]> =
	{
		answer_basic_question: "continue_qualification",
		answer_with_more_detail: "continue_qualification",
		ask_next_qualification_question: "continue_qualification",
		close: "close",
		close_conversation: "close",
		continue_qualification: "continue_qualification",

		offer_appointment: "offer_meeting",

		offer_meeting: "offer_meeting",
		reject_out_of_scope: "close",
		request_consultant: "request_consultant",
		schedule_meeting: "schedule_meeting",
		wait_for_schedule: "schedule_meeting",
	};

const CURRENT_SCHEDULING_INTENT_PATTERNS = [
	/\b(?:quero|queria|gostaria(?:\s+de)?|preciso(?:\s+de)?|pretendo|vou|posso|pode(?:ria)?|vamos|desejo)\s+(?:(?:ja|agora)\s+)?(?:agendar|marcar|reservar)\b/,
	/\b(?:agendar|marcar|reservar)\s+(?:um|uma|o|a)?\s*(?:horario|reuniao|conversa|atendimento|consulta)\b/,
	/\b(?:ver|consultar|conferir|checar|saber|receber)\s+(?:(?:os?|alguns?|um|uma)\s+)?(?:horarios?|disponibilidade|agenda|reuniao)\b/,
	/\b(?:tem|ha|existe)\s+(?:(?:algum|alguma|um|uma)\s+)?(?:horario|horarios|vaga)\s+(?:disponivel|disponiveis|livre|livres|para)\b/,
	/\b(?:quais|que)\s+(?:(?:sao|estao)\s+)?(?:os?\s+)?horarios?.*(?:disponiveis|disponivel|agenda|livre|livres|reuniao)\b/,
	/\b(?:passar|enviar|mostrar|dar)\s+(?:(?:os?|alguns?)\s+)?(?:horarios?|disponibilidade|agenda|horario)\b/,
	/\b(?:pode(?:ria)?|consegue|conseguiria)\b.*(?:passar|mandar|enviar|mostrar|dar)\b.*(?:horarios?|disponibilidade|agenda|horario|reuniao)\b/,
];

const NEGATED_SCHEDULING_INTENT_PATTERN =
	/\b(?:nao|nunca)\s+(?:(?:quero|queria|gostaria(?:\s+de)?|preciso(?:\s+de)?|pretendo|vou|posso)\s+)?(?:agendar|marcar|reservar|ver|consultar|conferir|checar|saber|receber)\b[^.!?]{0,40}\b(?:horarios?|disponibilidade|agenda|reuniao|conversa|atendimento|consulta|vaga)\b|\b(?:nao|nunca)\s+(?:(?:quero|queria|gostaria(?:\s+de)?|preciso(?:\s+de)?|pretendo|vou|posso)\s+)?(?:agendar|marcar|reservar)\b/;

// "horários de funcionamento/pagamento/..." são dúvidas comerciais, não pedido de agendamento.
const NON_SCHEDULING_HORARIO_PATTERN =
	/\bhorarios?\s+(?:de|do|da)\s+(?:funcionamento|abertura|fechamento|pagamento|vencimento|contrato|parcela|parcelas)\b/;

export function hasCurrentSchedulingIntent(currentMessages: string[]): boolean {
	return currentMessages.some((message) => {
		const normalizedMessage = message
			.normalize("NFD")
			.replace(/[\u0300-\u036f]/g, "")
			.toLowerCase();

		if (
			NEGATED_SCHEDULING_INTENT_PATTERN.test(normalizedMessage) ||
			NON_SCHEDULING_HORARIO_PATTERN.test(normalizedMessage)
		) {
			return false;
		}

		return CURRENT_SCHEDULING_INTENT_PATTERNS.some((pattern) =>
			pattern.test(normalizedMessage)
		);
	});
}

export type ExecuteNextActionResult =
	| {
			action: "continue_qualification";
			status: "executed";
	  }
	| {
			action: "offer_meeting";
			status: "executed";
	  }
	| {
			action: "request_consultant";
			status: "executed";
	  }
	| {
			action: "schedule_meeting";
			status: "pending";
	  }
	| {
			action: "close";
			status: "executed";
	  };

export interface ExecuteNextActionParams {
	/**
	 * O cliente aceitou, neste turno, a oferta sim/não de conversar com um
	 * consultor enviada pelo backend no turno anterior. Vale como intenção
	 * atual de agendamento somente neste turno.
	 */
	acceptedPendingOffer?: boolean;
	conversationId: string;
	currentMessages: string[];
	currentStatus: string;
	leadId: string;
	nextAction: NextAction;
	persistConversationStatus?: (input: {
		conversationId: string;
		status: "closed";
		updatedAt: Date;
	}) => Promise<{ id: string }>;
}

export async function executeNextAction({
	acceptedPendingOffer = false,
	conversationId,
	currentStatus,
	currentMessages,
	leadId,
	nextAction,
	persistConversationStatus = async ({
		conversationId: targetConversationId,
	}) => {
		const [updatedConversation] = await db
			.update(conversations)
			.set({
				status: "closed",
				updatedAt: new Date(),
			})
			.where(eq(conversations.id, targetConversationId))
			.returning();

		if (!updatedConversation) {
			throw new Error("Conversation not found");
		}

		return updatedConversation;
	},
}: ExecuteNextActionParams): Promise<ExecuteNextActionResult> {
	const resolvedConversationId = conversationId;
	const requestedAction =
		ACTION_ALIASES[nextAction as MarianaNextAction] ?? nextAction;
	// Aceite da oferta do próprio backend decide o fluxo; o modelo não é a
	// autoridade aqui. Encerramento continua respeitado.
	const normalizedAction =
		acceptedPendingOffer && requestedAction !== "close"
			? "offer_meeting"
			: requestedAction;
	const schedulingIntent =
		acceptedPendingOffer || hasCurrentSchedulingIntent(currentMessages);

	if (!resolvedConversationId) {
		throw new Error("Conversation id is required");
	}

	console.info({
		conversationId: resolvedConversationId,
		event: "agent_action_started",
		leadId,
		nextAction: normalizedAction,
		...(acceptedPendingOffer ? { reason: "accepted_pending_offer" } : {}),
	});

	if (normalizedAction === "continue_qualification") {
		console.info({
			conversationId: resolvedConversationId,
			event: "agent_action_executed",
			leadId,
			nextAction: normalizedAction,
		});

		return {
			action: "continue_qualification",
			status: "executed",
		};
	}

	if (normalizedAction === "request_consultant") {
		console.info({
			conversationId: resolvedConversationId,
			event: "agent_action_executed",
			leadId,
			nextAction: normalizedAction,
		});

		return {
			action: "request_consultant",
			status: "executed",
		};
	}

	if (normalizedAction === "offer_meeting") {
		if (!schedulingIntent) {
			console.info({
				conversationId: resolvedConversationId,
				event: "agent_action_blocked",
				leadId,
				nextAction: normalizedAction,
				reason: "no_current_scheduling_intent",
			});

			return {
				action: "continue_qualification",
				status: "executed",
			};
		}

		if (currentStatus !== "qualified") {
			console.info({
				conversationId: resolvedConversationId,
				event: "agent_action_blocked",
				leadId,
				nextAction: normalizedAction,
				reason: "lead_not_qualified",
			});

			return {
				action: "continue_qualification",
				status: "executed",
			};
		}

		console.info({
			conversationId: resolvedConversationId,
			event: "agent_action_executed",
			leadId,
			nextAction: normalizedAction,
		});

		return {
			action: "offer_meeting",
			status: "executed",
		};
	}

	if (normalizedAction === "schedule_meeting") {
		if (!schedulingIntent) {
			console.info({
				conversationId: resolvedConversationId,
				event: "agent_action_blocked",
				leadId,
				nextAction: normalizedAction,
				reason: "no_current_scheduling_intent",
			});

			return {
				action: "continue_qualification",
				status: "executed",
			};
		}

		if (currentStatus !== "qualified") {
			console.info({
				conversationId: resolvedConversationId,
				event: "agent_action_blocked",
				leadId,
				nextAction: normalizedAction,
				reason: "lead_not_qualified",
			});

			return {
				action: "continue_qualification",
				status: "executed",
			};
		}

		console.info({
			conversationId: resolvedConversationId,
			event: "agent_action_pending",
			leadId,
			nextAction: normalizedAction,
		});

		return {
			action: "schedule_meeting",
			status: "pending",
		};
	}

	if (normalizedAction === "close") {
		await persistConversationStatus({
			conversationId: resolvedConversationId,
			status: "closed",
			updatedAt: new Date(),
		});

		console.info({
			conversationId: resolvedConversationId,
			event: "conversation_closed",
			leadId,
		});

		return {
			action: "close",
			status: "executed",
		};
	}

	throw new Error(`Unsupported next action: ${String(nextAction)}`);
}
