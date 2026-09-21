/** biome-ignore-all lint/style/useFilenamingConvention: <> */

import { eq } from "drizzle-orm";

import { db } from "../../db/connections";
import { conversations, messages } from "../../db/schema";
import { env } from "../../env";
import {
	type GenerateMarianaResponseResult,
	generateMarianaResponse,
} from "./generateMarianaResponse";
import { MessageDebounceCoordinator } from "./message-debounce";

export const messageDebounceCoordinator = new MessageDebounceCoordinator(
	env.MESSAGE_DEBOUNCE_MS
);

export async function receiveCustomerMessage({
	content,
	conversationId,
	externalId,
	role,
	onMarianaResponse,
}: {
	content: string;
	conversationId: string;
	externalId?: string;
	role: "user" | "assistant" | "system";
	onMarianaResponse?: (
		result: GenerateMarianaResponseResult,
		context: { conversationId: string; leadId: string }
	) => Promise<void>;
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
			process: async ({ messages: debouncedMessages }) => {
				const messageCutoff = debouncedMessages.reduce(
					(latest, debouncedMessage) =>
						debouncedMessage.receivedAt > latest
							? debouncedMessage.receivedAt
							: latest,
					debouncedMessages[0]?.receivedAt ?? message.createdAt
				);
				const marianaResult = await generateMarianaResponse({
					currentMessages: debouncedMessages.map(
						(debouncedMessage) => debouncedMessage.content
					),
					leadId: conversation.leadId,
					messageCutoff,
					messageIds: debouncedMessages.map(
						(debouncedMessage) => debouncedMessage.id
					),
					persistUserMessage: false,
				});

				if (onMarianaResponse) {
					await onMarianaResponse(marianaResult, {
						conversationId,
						leadId: conversation.leadId,
					});
				}
			},
		});
	}

	return {
		duplicate: false,
		message,
	};
}
