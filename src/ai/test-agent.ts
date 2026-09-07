/** biome-ignore-all assist/source/useSortedKeys: <> */

import { generateMarianaResponse } from "../services/conversations/generateMarianaResponse";

async function main() {
	const result = await generateMarianaResponse({
		leadId: "85cd4677-ab28-4344-9b74-44b205a65c09",
		currentMessage:
			"Quero um consórcio de imóvel e penso em uma carta de 300 mil.",
	});

	console.log("reply:");
	console.log(result.result.reply);
	console.log("\nleadUpdate:");
	console.log(result.result.leadUpdate);
	console.log("\nnextAction:");
	console.log(result.result.nextAction);
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
