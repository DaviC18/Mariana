import { asc, eq } from "drizzle-orm";

import { db } from "../../db/connections";
import { conversations, leads, messages } from "../../db/schema";

export async function getConversationContext(conversationId: string) {
	const [conversation] = await db
		.select()
		.from(conversations)
		.where(eq(conversations.id, conversationId))
		.limit(1);

	if (!conversation) {
		throw new Error("Conversation not found");
	}

	const [lead] = await db
		.select()
		.from(leads)
		.where(eq(leads.id, conversation.leadId))
		.limit(1);

	if (!lead) {
		throw new Error("Lead not found");
	}

	const conversationMessages = await db
		.select()
		.from(messages)
		.where(eq(messages.conversationId, conversationId))
		.orderBy(asc(messages.createdAt));

	return {
		conversation,
		lead,
		messages: conversationMessages,
	};
}
