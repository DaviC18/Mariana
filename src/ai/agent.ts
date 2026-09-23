/** biome-ignore-all lint/style/useFilenamingConvention: <> */
/** biome-ignore-all lint/correctness/noUndeclaredVariables: <> */
/** biome-ignore-all assist/source/useSortedInterfaceMembers: <> */
/** biome-ignore-all lint/style/useDestructuring: <> */

import type { GenerateContentResponse } from "@google/genai";
import { z } from "zod";
import { assertSafeMarianaReply } from "../services/conversations/mariana-safety";
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
import { MARIANA_SYSTEM_PROMPT } from "./prompt";
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

export interface GenerateMarianaReplyParams {
	lead: MarianaLead;
	history: MarianaMessage[];
	currentMessages: MarianaMessage[];
	additionalContext?: string;
}

export interface GenerateMarianaReplyResult {
	metadata: {
		latencyMs: number;
		model: string;
		usage: GenerateContentResponse["usageMetadata"] | null;
	};
	result: MarianaResponse;
}

export async function generateMarianaReply({
	lead,
	history,
	currentMessages,
}: GenerateMarianaReplyParams): Promise<GenerateMarianaReplyResult> {
	const startedAt = Date.now();
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

	const contextualSystemPrompt = `
${MARIANA_SYSTEM_PROMPT}

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
${accessInstruction}
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
	const result = validateMarianaEvidence({
		commercialAccess,
		query: latestUserMessage,
		response: parsedResult,
		retrieval: knowledgeContext,
	});
	assertSafeMarianaReply(result.reply);

	return {
		metadata: {
			latencyMs: Date.now() - startedAt,
			model: response.modelVersion ?? MODEL,
			usage: response.usageMetadata ?? null,
		},
		result,
	};
}
