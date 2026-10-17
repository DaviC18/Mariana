/** biome-ignore-all lint/style/useFilenamingConvention: <> */
/** biome-ignore-all lint/correctness/noUndeclaredVariables: <> */
/** biome-ignore-all assist/source/useSortedInterfaceMembers: <> */
/** biome-ignore-all lint/style/useDestructuring: <> */

import type { GenerateContentResponse } from "@google/genai";
import { z } from "zod";
import type { ConversationStage } from "../services/conversations/conversation-stage";
import {
	assertSafeMarianaReply,
	sanitizeCommercialIdentity,
} from "../services/conversations/mariana-safety";
import type { PendingOffer } from "../services/conversations/pending-offer";
import {
	type BusinessProfile,
	resolveBusinessProfile,
} from "./business-profile";
import { ai } from "./client";
import { MARIANA_KNOWLEDGE } from "./knowledge";
import {
	COMMERCIAL_HANDOFF,
	LEVEL_TWO_INSTRUCTION,
	resolveCommercialAccess,
} from "./knowledge/commercial-policy";
import {
	formatKnowledgeContext,
	retrieveKnowledge,
} from "./knowledge/retrieve";
import { validateMarianaEvidence } from "./knowledge/validate-response";
import { buildMarianaSystemPrompt } from "./prompt";
import {
	type MarianaResponse,
	marianaResponseSchema,
} from "./schemas/mariana-response-schema";

const MODEL = "gemini-3.5-flash-lite";
const CODE_FENCE_START = /^```(?:json)?\s*/i;
const CODE_FENCE_END = /\s*```$/i;

export interface MarianaMessage {
	content: string;
	createdAt: Date;
	role: "user" | "assistant" | "system";
}

export interface MarianaLead {
	commercialApproach: string | null;
	consortiumType: string;
	currentSituation: string | null;
	name: string;
	objective: string;
	painPoint: string | null;
	status: string;
	urgency: string | null;
}

export interface MarianaConversationContext {
	/** Campos conhecidos e perguntas já feitas: nunca perguntar de novo. */
	doNotAsk: string[];
	isFirstContact: boolean;
	pendingOffer: PendingOffer | null;
	/** Pergunta que a aplicação acrescenta ao final da resposta, se houver. */
	question: string | null;
	stage: ConversationStage;
}

export interface GenerateMarianaReplyParams {
	additionalContext?: string;
	businessProfile?: BusinessProfile;
	conversationContext?: MarianaConversationContext;
	currentMessages: MarianaMessage[];
	history: MarianaMessage[];
	lead: MarianaLead;
}

export interface GenerateMarianaReplyResult {
	metadata: {
		latencyMs: number;
		model: string;
		usage: GenerateContentResponse["usageMetadata"] | null;
	};
	result: MarianaResponse;
}

const STAGE_GUIDANCE: Record<ConversationStage, string> = {
	confirmation:
		"O agendamento já foi confirmado. Responda de forma breve, sem novas perguntas comerciais.",
	consultant_offer:
		"O motivo do cliente já está claro. Responda brevemente; a aplicação acrescenta a oferta do consultor.",
	greeting:
		"Primeiro contato: cumprimente uma única vez, de forma breve, e se apresente como Mariana em uma frase.",
	info: "Responda dúvidas gerais com a base autorizada, em no máximo 3 frases.",
	name: "O nome do cliente ainda não é conhecido; a aplicação pergunta o nome.",
	reason:
		"O motivo do contato ainda não é conhecido; a aplicação pergunta o motivo.",
	scheduling:
		"O cliente quer falar com um consultor. A aplicação apresenta os horários; não invente horários nem prometa agendamento.",
};

export function buildConversationContextSection({
	doNotAsk,
	isFirstContact,
	pendingOffer,
	question,
	stage,
}: MarianaConversationContext): string {
	const greetingRule = isFirstContact
		? "Este é o primeiro contato da Mariana nesta conversa: cumprimente o cliente uma única vez, de forma breve."
		: 'A conversa já está em andamento: NÃO cumprimente novamente (sem "Olá", "Oi", "Boa noite" etc.) e vá direto ao ponto.';

	const questionRule = question
		? `A aplicação vai acrescentar ao final da sua mensagem exatamente esta pergunta: "${question}". Não escreva nenhuma pergunta: escreva no máximo 2 frases curtas que combinem com ela.`
		: "Não há pergunta da aplicação neste turno. Não escreva perguntas de qualificação; responda em no máximo 3 frases curtas.";

	const doNotAskSection =
		doNotAsk.length > 0
			? [
					"Nunca pergunte de novo:",
					...doNotAsk.map((item) => `- ${item}`),
				].join("\n")
			: "";

	const pendingOfferRule =
		pendingOffer === "consultant_meeting"
			? "Sua mensagem anterior ofereceu procurar um horário com um consultor. Se o cliente aceitou, a aplicação apresentará os horários."
			: "";

	return `
# CONTEXTO DA CONVERSA

Etapa atual: ${stage}. ${STAGE_GUIDANCE[stage]}

${greetingRule}

${questionRule}

${doNotAskSection}

${pendingOfferRule}

Uma mensagem do cliente pode responder vários campos ao mesmo tempo: registre todos em \`leadUpdate\`. Ex.: "tenho um carro usado e quero um novo" → \`currentSituation\` = "tem um carro usado" e \`objective\` = "comprar um carro novo". Situação atual (o que o cliente tem ou vive hoje) não é motivação (\`painPoint\`, por que quer agora).

Respostas como "carro", "veículo", "moto", "casa", "apartamento" ou "imóvel" já informam o objetivo e o tipo de consórcio. Registre os dois em \`leadUpdate\`.

Se o nome do cliente ainda não for conhecido e ele o informar, registre-o em \`leadUpdate.name\`.

Se o cliente disser que já respondeu ("já disse isso"), peça desculpa em poucas palavras e avance.

Se o cliente perguntar "o que você me indica?" ou algo parecido, dê uma explicação breve e geral sobre como o consórcio funciona para o objetivo dele, sem recomendar grupo, carta de crédito ou valores.
`;
}

export async function generateMarianaReply({
	businessProfile,
	conversationContext,
	currentMessages,
	history,
	lead,
}: GenerateMarianaReplyParams): Promise<GenerateMarianaReplyResult> {
	const startedAt = Date.now();
	const profile = resolveBusinessProfile(businessProfile);
	const allMessages = [...history, ...currentMessages];

	const contents = allMessages
		.filter((message) => message.role !== "system")
		.map((message) => ({
			parts: [
				{
					text: message.content,
				},
			],
			role: message.role === "assistant" ? "model" : "user",
		}));

	const currentUserMessages = currentMessages.filter(
		(message) => message.role === "user"
	);

	const latestUserMessage =
		[...currentMessages].reverse().find((message) => message.role === "user")
			?.content ?? "";

	const currentBlockQuery = currentUserMessages
		.map((message) => message.content)
		.join("\n");

	const knowledgeContext = retrieveKnowledge({
		businessProfile: profile,
		items: MARIANA_KNOWLEDGE,
		query: currentBlockQuery,
	});

	const commercialAccess = resolveCommercialAccess({
		message: currentBlockQuery,
		retrievedKnowledge: knowledgeContext,
	});

	if (commercialAccess.level === 3) {
		return {
			metadata: {
				latencyMs: Date.now() - startedAt,
				model: MODEL,
				usage: null,
			},
			result: marianaResponseSchema.parse({
				businessAction: "request_consultant",
				evidenceUsed: [],
				leadUpdate: { status: lead.status },
				nextAction: "request_consultant",
				reply: COMMERCIAL_HANDOFF,
			}),
		};
	}

	const accessInstruction =
		commercialAccess.level === 2 ? `\n\n${LEVEL_TWO_INSTRUCTION}` : "";

	const baseSystemPrompt = buildMarianaSystemPrompt(profile);

	const contextualSystemPrompt = `
${baseSystemPrompt}

	# BASE DE CONHECIMENTO AUTORIZADA

	${formatKnowledgeContext(knowledgeContext)}

# CONTEXTO ATUAL DO LEAD

Nome: ${lead.name}
Objetivo: ${lead.objective}
Tipo de consórcio: ${lead.consortiumType}
Ponto de dor: ${lead.painPoint ?? "não informado"}
Urgência: ${lead.urgency ?? "não informada"}
Situação atual: ${lead.currentSituation ?? "não informada"}
Abordagem comercial: ${lead.commercialApproach ?? "não informada"}
Status: ${lead.status}
${conversationContext ? buildConversationContextSection(conversationContext) : ""}${accessInstruction}
`;

	const response = await ai.models.generateContent({
		config: {
			responseJsonSchema: z.toJSONSchema(marianaResponseSchema),
			responseMimeType: "application/json",
			systemInstruction: contextualSystemPrompt,
		},
		contents,
		model: MODEL,
	});

	const rawText = response.text;
	if (!rawText) {
		throw new Error("Gemini returned an empty response");
	}

	let parsed: unknown;
	const normalizedText = rawText.trim();
	const jsonCandidate = normalizedText.startsWith("```")
		? normalizedText.replace(CODE_FENCE_START, "").replace(CODE_FENCE_END, "")
		: normalizedText;

	try {
		parsed = JSON.parse(jsonCandidate);
	} catch (error) {
		throw new Error("Gemini response was not valid JSON", { cause: error });
	}

	const parsedResult = marianaResponseSchema.parse(parsed);
	const sanitizedReply = sanitizeCommercialIdentity(
		parsedResult.reply,
		profile
	);
	const result = validateMarianaEvidence({
		clientStatedText: currentBlockQuery,
		commercialAccess,
		query: latestUserMessage,
		response: {
			...parsedResult,
			reply: sanitizedReply,
		},
		retrieval: knowledgeContext,
	});
	assertSafeMarianaReply(result.reply, profile);

	return {
		metadata: {
			latencyMs: Date.now() - startedAt,
			model: response.modelVersion ?? MODEL,
			usage: response.usageMetadata ?? null,
		},
		result,
	};
}
