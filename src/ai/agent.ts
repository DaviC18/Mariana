/** biome-ignore-all lint/style/useFilenamingConvention: <> */
/** biome-ignore-all lint/style/useDestructuring: <> */

import { ai } from "./client";
import { MARIANA_SYSTEM_PROMPT } from "./prompt";
import type { GenerateMarianaResponseParams } from "./types";

const MODEL = "gemini-3.5-flash";

export async function generateMarianaResponse({
	lead,
	messages,
	currentMessage,
}: GenerateMarianaResponseParams): Promise<string> {
	const history = messages
		.filter(
			(message) => message.role === "user" || message.role === "assistant"
		)
		.map((message) => ({
			parts: [{ text: message.content }],
			role: message.role === "assistant" ? "model" : "user",
		}));

	const leadContext = `
Contexto do lead:

Nome: ${lead.name}
Objetivo: ${lead.objective}
Tipo de consórcio: ${lead.consortiumType}
Status: ${lead.status}
`;

	const response = await ai.models.generateContent({
		config: {
			systemInstruction: MARIANA_SYSTEM_PROMPT,
			temperature: 0.3,
		},
		contents: [
			{
				parts: [
					{
						text: leadContext,
					},
				],
				role: "user",
			},
			...history,
			{
				parts: [{ text: currentMessage }],
				role: "user",
			},
		],
		model: MODEL,
	});

	const text = response.text;

	if (!text) {
		throw new Error("Gemini returned an empty response");
	}

	return text;
}
