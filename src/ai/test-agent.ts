/** biome-ignore-all lint/style/useDestructuring: <> */
import { getConversationContext } from "../services/conversations/getConversationContext";
import { generateMarianaResponse } from "./agent";

async function main() {
	const conversationId = process.argv[2];

	if (!conversationId) {
		throw new Error("Provide a conversation ID");
	}

	const context = await getConversationContext(conversationId);

	const currentMessage = process.argv.slice(3).join(" ");

	if (!currentMessage) {
		throw new Error("Provide a message");
	}

	const response = await generateMarianaResponse({
		currentMessage,
		lead: context.lead,
		messages: context.messages,
	});

	console.log("\nMariana:\n");
	console.log(response);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
