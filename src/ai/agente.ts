/** biome-ignore-all lint/style/useDestructuring: <> */
import { ai } from "./client";
import { MARIANA_SYSTEM_PROMPT } from "./prompt";

const MODEL = "gemini-3.5-flash";

export interface GenerateMarianaResponseParams {
	message: string;
}

export async function generateMarianaResponse({
	message,
}: GenerateMarianaResponseParams): Promise<string> {
	const response = await ai.models.generateContent({
		config: {
			systemInstruction: MARIANA_SYSTEM_PROMPT,
			temperature: 0.3,
		},
		contents: message,
		model: MODEL,
	});

	const text = response.text;

	if (!text) {
		throw new Error("Gemini returned an empty response");
	}

	return text;
}
