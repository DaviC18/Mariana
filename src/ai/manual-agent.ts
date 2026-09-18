/** biome-ignore-all assist/source/useSortedKeys: <> */

import { fileURLToPath } from "node:url";

import { generateMarianaResponse } from "../services/conversations/generateMarianaResponse";

const currentScriptPath = fileURLToPath(import.meta.url);
const invokedScriptPath = process.argv[1]
	? fileURLToPath(new URL(process.argv[1], "file://"))
	: undefined;

if (invokedScriptPath !== currentScriptPath) {
	process.exit(0);
}

async function main() {
	const result = await generateMarianaResponse({
		leadId: "85cd4677-ab28-4344-9b74-44b205a65c09",
		currentMessages: [
			"Quero um consórcio de imóvel e penso em uma carta de 300 mil.",
		],
	});

	console.log("reply:");
	console.log(result.result.reply);
	console.log("\nleadUpdate:");
	console.log(result.result.leadUpdate);
	console.log("\nnextAction:");
	console.log(result.result.nextAction);
	console.log("\nactionResult:");
	console.log(result.actionResult);
	console.log("\nmetadata:");
	console.log({
		latencyMs: result.metadata.latencyMs,
		model: result.metadata.model,
		usage: result.metadata.usage ?? null,
	});
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
