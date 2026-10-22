/** biome-ignore-all lint/style/useFilenamingConvention: <> */
/** biome-ignore-all lint/correctness/noUndeclaredVariables: <> */
/** biome-ignore-all assist/source/useSortedInterfaceMembers: <> */
/** biome-ignore-all lint/style/useDestructuring: <> */

import {
	type GenerateContentConfig,
	type GenerateContentResponse,
	ThinkingLevel,
} from "@google/genai";
import { z } from "zod";
import { env } from "../env";
import {
	buildRewriteRecord,
	hashText,
	type RewriteLayer,
	type RewriteRecord,
} from "../lib/turn-trace";
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
import { ModelUnavailableError } from "./model-errors";
import { buildMarianaSystemPrompt } from "./prompt";
import {
	type MarianaResponse,
	marianaResponseSchema,
} from "./schemas/mariana-response-schema";

const CODE_FENCE_START = /^```(?:json)?\s*/i;
const CODE_FENCE_END = /\s*```$/i;

/** Nome do modelo: vem do ambiente, nunca de uma constante no código. */
export function resolveModelName(): string {
	return env.GEMINI_MODEL;
}

/**
 * Configuração da chamada ao Gemini. Função pura: é o ponto de teste da
 * amostragem (temperatura, limite de saída, nível de raciocínio) sem que
 * nenhum teste chegue à API.
 */
export function buildModelRequestConfig({
	systemInstruction,
}: {
	systemInstruction: string;
}): GenerateContentConfig {
	return {
		maxOutputTokens: env.GEMINI_MAX_OUTPUT_TOKENS,
		responseJsonSchema: z.toJSONSchema(marianaResponseSchema),
		responseMimeType: "application/json",
		systemInstruction,
		temperature: env.GEMINI_TEMPERATURE,
		// O enum do SDK tem exatamente os mesmos valores do env (MINIMAL, LOW,
		// MEDIUM, HIGH), então o acesso por chave é seguro.
		thinkingConfig: { thinkingLevel: ThinkingLevel[env.GEMINI_THINKING_LEVEL] },
	};
}

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

/** O mesmo contrato de `ai.models.generateContent`: é o seam de teste. */
export type GenerateContentFn = typeof ai.models.generateContent;

export interface GenerateMarianaReplyParams {
	additionalContext?: string;
	businessProfile?: BusinessProfile;
	conversationContext?: MarianaConversationContext;
	currentMessages: MarianaMessage[];
	/** Só os testes passam outro: o default é o cliente Gemini real. */
	generateContentFn?: GenerateContentFn;
	history: MarianaMessage[];
	lead: MarianaLead;
}

export interface GenerateMarianaReplyResult {
	metadata: {
		/** Nível 1, 2 ou 3 da política comercial deste turno. */
		commercialAccessLevel?: 1 | 2 | 3;
		/** `MAX_TOKENS` aqui significa JSON truncado. */
		finishReason?: string | null;
		latencyMs: number;
		model: string;
		/**
		 * O que a API devolveu, `null` quando ela omitiu. Diferente de `model`,
		 * que cai no nome configurado: um campo "returned" não pode conter um
		 * valor que ninguém devolveu.
		 */
		modelVersionReturned?: string | null;
		/** Hash e comprimento da resposta do modelo antes de qualquer camada. */
		rawReplyHash?: string;
		rawReplyLength?: number;
		/** O que o modelo pediu, antes do portão de ações decidir. */
		requestedNextAction?: string;
		/** Uma entrada por camada que mudou o texto (L0–L4 nesta função). */
		rewrites?: RewriteRecord[];
		usage: GenerateContentResponse["usageMetadata"] | null;
	};
	result: MarianaResponse;
}

/**
 * Os registros parciais viajam no erro quando L2 ou L4 lançam, junto do id da
 * camada que lançou (decisão P-1 do plano): `outcome: "guardrail_throw"`
 * sozinho não separa um id de evidência inventado de uma identidade proibida.
 */
export interface TurnRewritesCarrier {
	turnGuardrailLayer?: RewriteLayer;
	turnRewrites?: RewriteRecord[];
}

function withRewrites(
	error: unknown,
	rewrites: RewriteRecord[],
	guardrailLayer: RewriteLayer
): unknown {
	if (error instanceof Error) {
		const carrier = error as Error & TurnRewritesCarrier;

		carrier.turnGuardrailLayer = guardrailLayer;
		carrier.turnRewrites = rewrites;
	}

	return error;
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

/** Tira a cerca de código e lê o JSON. Falha de leitura é falha de modelo. */
function parseModelJson(rawText: string): unknown {
	const normalizedText = rawText.trim();
	const jsonCandidate = normalizedText.startsWith("```")
		? normalizedText.replace(CODE_FENCE_START, "").replace(CODE_FENCE_END, "")
		: normalizedText;

	try {
		return JSON.parse(jsonCandidate);
	} catch (error) {
		throw new ModelUnavailableError("Gemini response was not valid JSON", {
			cause: error,
			kind: "invalid_json",
		});
	}
}

export async function generateMarianaReply({
	businessProfile,
	conversationContext,
	currentMessages,
	generateContentFn,
	history,
	lead,
}: GenerateMarianaReplyParams): Promise<GenerateMarianaReplyResult> {
	const callModel: GenerateContentFn =
		generateContentFn ?? ((params) => ai.models.generateContent(params));
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
				commercialAccessLevel: 3,
				finishReason: null,
				latencyMs: Date.now() - startedAt,
				model: resolveModelName(),
				modelVersionReturned: null,
				rawReplyHash: hashText(""),
				rawReplyLength: 0,
				requestedNextAction: "request_consultant",
				// O modelo nunca foi chamado: o texto é 100% do backend.
				rewrites: [
					buildRewriteRecord("L0_level3_short_circuit", "", COMMERCIAL_HANDOFF),
				],
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

	let response: GenerateContentResponse;
	try {
		response = await callModel({
			config: buildModelRequestConfig({
				systemInstruction: contextualSystemPrompt,
			}),
			contents,
			model: resolveModelName(),
		});
	} catch (error) {
		// A chamada não chegou a produzir resposta: falha de transporte.
		throw new ModelUnavailableError(
			"Gemini request failed before producing a response",
			{ cause: error, kind: "transport" }
		);
	}

	const rawText = response.text;
	if (!rawText) {
		throw new ModelUnavailableError("Gemini returned an empty response", {
			kind: "empty_response",
		});
	}

	const parsed = parseModelJson(rawText);

	const parsedResult = marianaResponseSchema.parse(parsed);
	const rawReply = parsedResult.reply;
	const rewrites: RewriteRecord[] = [];

	const sanitizedReply = sanitizeCommercialIdentity(rawReply, profile);
	if (sanitizedReply !== rawReply) {
		rewrites.push(
			buildRewriteRecord("L1_identity_sanitizer", rawReply, sanitizedReply)
		);
	}

	let result: MarianaResponse;
	try {
		result = validateMarianaEvidence({
			clientStatedText: currentBlockQuery,
			commercialAccess,
			query: latestUserMessage,
			response: {
				...parsedResult,
				reply: sanitizedReply,
			},
			retrieval: knowledgeContext,
		});
	} catch (error) {
		// L2: a validação de evidência lança. Os registros parciais viajam no
		// erro para que o turno ainda possa ser rastreado.
		throw withRewrites(error, rewrites, "L2_evidence_invalid_id");
	}

	if (result.reply !== sanitizedReply) {
		rewrites.push(
			buildRewriteRecord("L3_evidence_handoff", sanitizedReply, result.reply)
		);
	}

	try {
		assertSafeMarianaReply(result.reply, profile);
	} catch (error) {
		// L4: a asserção de segurança lança.
		throw withRewrites(error, rewrites, "L4_safety_assertion");
	}

	return {
		metadata: {
			commercialAccessLevel: commercialAccess.level,
			finishReason: response.candidates?.[0]?.finishReason ?? null,
			latencyMs: Date.now() - startedAt,
			model: response.modelVersion ?? resolveModelName(),
			modelVersionReturned: response.modelVersion ?? null,
			rawReplyHash: hashText(rawReply),
			rawReplyLength: rawReply.length,
			requestedNextAction: parsedResult.nextAction,
			rewrites,
			usage: response.usageMetadata ?? null,
		},
		result,
	};
}
