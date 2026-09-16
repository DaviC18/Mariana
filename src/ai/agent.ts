/** biome-ignore-all lint/style/useFilenamingConvention: <> */
/** biome-ignore-all lint/style/useDestructuring: <> */

import type { GenerateContentResponse } from "@google/genai";
import { z } from "zod";
import { assertSafeMarianaReply } from "../services/conversations/mariana-safety";
import { ai } from "./client";
import { MARIANA_KNOWLEDGE } from "./knowledge";
import { MARIANA_SYSTEM_PROMPT } from "./prompt";
import {
	type MarianaResponse,
	marianaResponseSchema,
} from "./schemas/mariana-response-schema";

const MODEL = "gemini-3.6-flash";
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
	messages: MarianaMessage[];
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
	messages,
}: GenerateMarianaReplyParams): Promise<GenerateMarianaReplyResult> {
	const startedAt = Date.now();

	const contents = messages
		.filter((message) => message.role !== "system")
		.map((message) => ({
			parts: [
				{
					text: message.content,
				},
			],
			role: message.role === "assistant" ? "model" : "user",
		}));

	const contextualSystemPrompt = `
${MARIANA_SYSTEM_PROMPT}

	# BASE DE CONHECIMENTO AUTORIZADA

	${MARIANA_KNOWLEDGE}

# CONTEXTO ATUAL DO LEAD

Nome: ${lead.name}
Objetivo: ${lead.objective}
Tipo de consórcio: ${lead.consortiumType}
Ponto de dor: ${lead.painPoint ?? "não informado"}
Urgência: ${lead.urgency ?? "não informada"}
Situação atual: ${lead.currentSituation ?? "não informada"}
Abordagem comercial: ${lead.commercialApproach ?? "não informada"}
Status: ${lead.status}
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

	const result = marianaResponseSchema.parse(parsed);
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
