/** biome-ignore-all lint/style/useFilenamingConvention: <> */

import type { InferInsertModel } from "drizzle-orm";
import { and, asc, eq } from "drizzle-orm";

import {
	type GenerateMarianaReplyResult,
	generateMarianaReply,
} from "../../ai/agent";
import { db } from "../../db/connections";
import { appointments, conversations, leads, messages } from "../../db/schema";
import { executeNextAction } from "../agent/execute-next-action";
import type { LeadStatus } from "../leads/lead-status";
import { updateLeadFromAgent } from "../leads/update-lead-from-agent";

type PersistLeadTransactionValues = Partial<InferInsertModel<typeof leads>> & {
	updatedAt: Date;
};

export interface GenerateMarianaResponseParams {
	currentMessage: string;
	leadId: string;
}

export interface GenerateMarianaResponseResult {
	actionResult: Awaited<ReturnType<typeof executeNextAction>>;
	metadata: GenerateMarianaReplyResult["metadata"];
	result: GenerateMarianaReplyResult["result"];
}

async function persistLeadUpdate({
	leadId,
	values,
	tx,
}: {
	leadId: string;
	values: PersistLeadTransactionValues & { status: LeadStatus };
	tx: Parameters<Parameters<typeof db.transaction>[0]>[0];
}) {
	const [updatedLead] = await tx
		.update(leads)
		.set({
			...(values.commercialApproach === undefined
				? {}
				: { commercialApproach: values.commercialApproach }),
			...(values.consortiumType === undefined
				? {}
				: { consortiumType: values.consortiumType }),
			...(values.currentSituation === undefined
				? {}
				: { currentSituation: values.currentSituation }),
			...(values.objective === undefined
				? {}
				: { objective: values.objective }),
			...(values.painPoint === undefined
				? {}
				: { painPoint: values.painPoint }),
			...(values.qualifiedAt === undefined
				? {}
				: { qualifiedAt: values.qualifiedAt }),
			...(values.urgency === undefined ? {} : { urgency: values.urgency }),
			status: values.status,
			updatedAt: values.updatedAt,
		})
		.where(eq(leads.id, leadId))
		.returning();

	if (!updatedLead) {
		throw new Error("Lead not found");
	}

	return updatedLead;
}

export async function generateMarianaResponse({
	leadId,
	currentMessage,
}: GenerateMarianaResponseParams): Promise<GenerateMarianaResponseResult> {
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

	// 8. Valida regra de negócio antes de persistir qualquer mudança de status
	const [existingAppointment] = await db
		.select({ id: appointments.id })
		.from(appointments)
		.where(eq(appointments.leadId, leadId))
		.limit(1);

	const appointmentCreated = Boolean(existingAppointment);

	// 9. Salva resposta da Mariana e aplica a atualização do lead apenas se a transição for permitida
	const actionResult = await db.transaction(async (tx) => {
		await updateLeadFromAgent({
			appointmentCreated,
			currentStatus: lead.status,
			leadId,
			leadUpdate: response.result.leadUpdate,
			persistLead: async ({ leadId: targetLeadId, values }) =>
				persistLeadUpdate({
					leadId: targetLeadId,
					tx,
					values,
				}),
		});

		const nextActionResult = await executeNextAction({
			conversationId: activeConversation.id,
			leadId,
			nextAction: response.result.nextAction,
			persistConversationStatus: async ({
				conversationId: targetConversationId,
				status,
				updatedAt,
			}) => {
				const [updatedConversation] = await tx
					.update(conversations)
					.set({
						status,
						updatedAt,
					})
					.where(eq(conversations.id, targetConversationId))
					.returning();

				if (!updatedConversation) {
					throw new Error("Conversation not found");
				}

				return updatedConversation;
			},
		});

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

		return nextActionResult;
	});

	return {
		actionResult,
		metadata: response.metadata,
		result: response.result,
	};
}
