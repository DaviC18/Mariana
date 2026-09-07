/** biome-ignore-all lint/style/useFilenamingConvention: <> */

import { and, asc, eq } from "drizzle-orm";

import {
	type GenerateMarianaReplyResult,
	generateMarianaReply,
} from "../../ai/agent";
import { db } from "../../db/connections";
import { conversations, leads, messages } from "../../db/schema";

export interface GenerateMarianaResponseParams {
	currentMessage: string;
	leadId: string;
}

export async function generateMarianaResponse({
	leadId,
	currentMessage,
}: GenerateMarianaResponseParams): Promise<GenerateMarianaReplyResult> {
	// 1. Busca o lead
	const [lead] = await db
		.select()
		.from(leads)
		.where(eq(leads.id, leadId))
		.limit(1);

	if (!lead) {
		throw new Error("Lead not found");
	}

	// 2. Busca a conversation ativa
	const [activeConversation] = await db
		.select()
		.from(conversations)
		.where(
			and(eq(conversations.leadId, leadId), eq(conversations.status, "active"))
		)
		.limit(1);

	if (!activeConversation) {
		throw new Error("Active conversation not found");
	}

	// 3. Salva a mensagem do usuário
	await db.insert(messages).values({
		content: currentMessage,
		conversationId: activeConversation.id,
		role: "user",
	});

	// 4. Busca o histórico
	const history = await db
		.select()
		.from(messages)
		.where(eq(messages.conversationId, activeConversation.id))
		.orderBy(asc(messages.createdAt));

	// 5. Contexto do lead
	const agentLead = {
		consortiumType: lead.consortiumType,
		name: lead.name,
		objective: lead.objective,
		phone: lead.phone,
		status: lead.status,
	};

	// 6. Converte histórico
	const agentMessages = history.map((message) => ({
		content: message.content,
		createdAt: message.createdAt,
		role: message.role,
	}));

	// 7. Chama a IA
	const response = await generateMarianaReply({
		lead: agentLead,
		messages: agentMessages,
	});

	// 8. Salva resposta da Mariana
	await db.transaction(async (tx) => {
		await tx.insert(messages).values({
			content: response.result.reply,
			conversationId: activeConversation.id,
			role: "assistant",
		});

		await tx
			.update(conversations)
			.set({
				updatedAt: new Date(),
			})
			.where(eq(conversations.id, activeConversation.id));
	});

	return response;
}
