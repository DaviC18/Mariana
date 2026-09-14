/** biome-ignore-all lint/style/useFilenamingConvention: <> */

import { eq } from "drizzle-orm";

import { db } from "../../db/connections";
import { conversations, messages } from "../../db/schema";
import { env } from "../../env";
import { generateMarianaResponse } from "./generateMarianaResponse";
import { MessageDebounceCoordinator } from "./message-debounce";

export const messageDebounceCoordinator = new MessageDebounceCoordinator(
	env.MESSAGE_DEBOUNCE_MS
);

export async function receiveCustomerMessage({
	content,
	conversationId,
	externalId,
	role,
}: {
	content: string;
	conversationId: string;
	externalId?: string;
	role: "user" | "assistant" | "system";
}) {
	const [conversation] = await db
		.select({ id: conversations.id, leadId: conversations.leadId })
		.from(conversations)
		.where(eq(conversations.id, conversationId))
		.limit(1);

	if (!conversation) {
		throw new Error("Conversation not found");
	}

	if (externalId) {
		const [existingMessage] = await db
			.select()
			.from(messages)
			.where(eq(messages.externalId, externalId))
			.limit(1);

		if (existingMessage) {
			return {
				duplicate: true,
				message: existingMessage,
			};
		}
	}

	const [message] = await db
		.insert(messages)
		.values({
			content,
			conversationId,
			externalId,
			role,
		})
		.returning();

	await db
		.update(conversations)
		.set({ updatedAt: new Date() })
		.where(eq(conversations.id, conversationId));

	if (role === "user") {
		messageDebounceCoordinator.schedule({
			conversationId,
			message: {
				content: message.content,
				id: message.id,
				receivedAt: message.createdAt,
			},
			process: async () => {
				const messageCutoff = message.createdAt;
				await generateMarianaResponse({
					currentMessage: "",
					leadId: conversation.leadId,
					messageCutoff,
					persistUserMessage: false,
				});
			},
		});
	}

	return {
		duplicate: false,
		message,
	};
}
