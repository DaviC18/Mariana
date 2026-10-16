/** biome-ignore-all lint/suspicious/useAwait: <> */
import assert from "node:assert/strict";
import test from "node:test";

import { eq } from "drizzle-orm";

import { COMMERCIAL_HANDOFF } from "../../ai/knowledge/commercial-policy";
import { closeDatabase, db } from "../../db/connections";
import { conversations, leads, messages } from "../../db/schema";
import { SchedulingAvailabilityService } from "../../services/calendar/scheduling-availability";
import { generateMarianaResponse } from "../../services/conversations/generateMarianaResponse";
import { buildQualificationFallbackReply } from "../../services/leads/qualification-gaps";

test.after(async () => {
	await closeDatabase();
});

test("offer_meeting bloqueado não repete a última pergunta da assistente", async () => {
	const [lead] = await db
		.insert(leads)
		.values({
			consortiumType: "imóvel",
			currentSituation: "Moro de aluguel",
			interestedInConsultant: false,
			name: "Lead Loop Fallback",
			objective: "Comprar um imóvel",
			painPoint: "Quero parar de pagar aluguel",
			phone: `551193${Date.now().toString().slice(-8)}`,
			status: "qualifying",
		})
		.returning({ id: leads.id });

	assert.ok(lead);

	const [conversation] = await db
		.insert(conversations)
		.values({ leadId: lead.id })
		.returning({ id: conversations.id });

	assert.ok(conversation);

	const consultantQuestion = buildQualificationFallbackReply([
		"interestedInConsultant",
	]);
	const base = Date.now() - 60_000;

	await db.insert(messages).values(
		[
			{ content: "a faixa de credito é de R$ 100 mil", role: "user" as const },
			{ content: COMMERCIAL_HANDOFF, role: "assistant" as const },
			{ content: "sim porfavor", role: "user" as const },
			{ content: consultantQuestion, role: "assistant" as const },
		].map((message, index) => ({
			...message,
			conversationId: conversation.id,
			createdAt: new Date(base + index * 1000),
		}))
	);

	const schedulingAvailabilityService = new SchedulingAvailabilityService();
	schedulingAvailabilityService.getAvailableSlots = async () => {
		throw new Error("Calendar não deve ser consultado sem autorização");
	};

	try {
		const result = await generateMarianaResponse({
			currentMessages: ["sim eu quero"],
			generateMarianaReplyFn: async () => ({
				metadata: { latencyMs: 1, model: "test-model", usage: null },
				result: {
					leadUpdate: { status: "qualifying" },
					nextAction: "offer_meeting",
					reply: "Ótimo! Vou verificar os horários disponíveis.",
				},
			}),
			leadId: lead.id,
			schedulingAvailabilityService,
		});

		assert.notEqual(result.result.reply, consultantQuestion);
		assert.notEqual(result.assistantMessage?.content, consultantQuestion);
	} finally {
		await db
			.delete(messages)
			.where(eq(messages.conversationId, conversation.id));
		await db.delete(conversations).where(eq(conversations.id, conversation.id));
		await db.delete(leads).where(eq(leads.id, lead.id));
	}
});
