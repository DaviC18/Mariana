/** biome-ignore-all assist/source/useSortedKeys: <> */
import { z } from "zod";

import { ai } from "./client";

const testSchema = z.object({
	reply: z.string(),
	nextAction: z.enum(["continue_qualification", "close"]),
});

async function main() {
	console.log("Testando configuração estruturada do Gemini...");

	const response = await ai.models.generateContent({
		model: "gemini-3.5-flash-lite",
		contents: "O que é um consórcio? Responda de forma breve.",
		config: {
			responseMimeType: "application/json",
			responseJsonSchema: z.toJSONSchema(testSchema),
			systemInstruction:
				"Você é um assistente de atendimento. Responda somente informações gerais sobre consórcio.",
		},
	});

	console.log("Modelo:", response.modelVersion);
	console.log("Resposta:", response.text);
}

main().catch((error) => {
	console.error("ERRO:", error);
	process.exit(1);
});
