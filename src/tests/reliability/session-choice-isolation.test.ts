/** biome-ignore-all lint/performance/noAwaitInLoops: <> */
/** biome-ignore-all lint/suspicious/useAwait: <> */
/**
 * Crux case (plan Step 8): a new conversation B never inherits the previous
 * conversation's commercial state. A lead that talked about a vehicle in A
 * asks about "consórcio de imóvel" in B; the prompt and the qualification
 * input handed to the model must carry no vehicle state.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { eq } from "drizzle-orm";

import type { generateMarianaReply } from "../../ai/agent";
import { closeDatabase, db } from "../../db/connections";
import { autonomousTasks } from "../../db/schema/autonomous-tasks";
import { conversations } from "../../db/schema/conversations";
import { leads } from "../../db/schema/leads";
import { messages } from "../../db/schema/messages";
import { outboundMessages } from "../../db/schema/outbound-messages";
import {
	createAutonomousTaskHandlers,
	PROCESS_SESSION_CHOICE_TASK,
} from "../../services/conversations/autonomous-task-handlers";
import { generateMarianaResponse } from "../../services/conversations/generateMarianaResponse";
import { openSessionChoice } from "../../services/conversations/session-choice-store";

test.after(async () => {
	await closeDatabase();
});

async function createFixture() {
	const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
	const [lead] = await db
		.insert(leads)
		.values({
			consortiumType: "veículo",
			currentSituation: "Tenho um carro antigo",
			interestedInConsultant: true,
			name: `Lead Isolamento ${suffix}`,
			objective: "consórcio de carro",
			painPoint: "trocar o carro",
			phone: `551196${suffix.slice(-9)}`,
			status: "qualifying",
			urgency: "short_term",
		})
		.returning({ id: leads.id });
	assert.ok(lead);

	const [conversation] = await db
		.insert(conversations)
		.values({ leadId: lead.id })
		.returning({ id: conversations.id });
	assert.ok(conversation);

	return { conversationAId: conversation.id, leadId: lead.id };
}

async function cleanup(leadId: string) {
	const convs = await db
		.select({ id: conversations.id })
		.from(conversations)
		.where(eq(conversations.leadId, leadId));
	for (const conv of convs) {
		await db
			.delete(outboundMessages)
			.where(eq(outboundMessages.conversationId, conv.id));
		await db
			.delete(autonomousTasks)
			.where(eq(autonomousTasks.conversationId, conv.id));
		await db.delete(messages).where(eq(messages.conversationId, conv.id));
	}
	await db.delete(conversations).where(eq(conversations.leadId, leadId));
	await db.delete(leads).where(eq(leads.id, leadId));
}

async function runNewConversation(conversationId: string) {
	const handlers = createAutonomousTaskHandlers();
	const handler = handlers[PROCESS_SESSION_CHOICE_TASK];
	assert.ok(handler);

	const [task] = await db
		.insert(autonomousTasks)
		.values({
			conversationId,
			idempotencyKey: `session-choice:${conversationId}`,
			payload: { buttonId: "sessao:nova", kind: "button" },
			status: "processing",
			taskType: PROCESS_SESSION_CHOICE_TASK,
		})
		.returning();

	await handler({
		leaseToken: "t1",
		renewLease: async () => true,
		task,
	} as any);
}

test("pergunta de imóvel em B não recebe estado de veículo de A", async () => {
	const { conversationAId, leadId } = await createFixture();

	try {
		// A has completed history and a vehicle objective. Its messages are
		// already processed, so the "nova" branch leaves them in A.
		await db.insert(messages).values([
			{
				content: "quero um consórcio de carro",
				conversationId: conversationAId,
				processedAt: new Date(),
				role: "user",
			},
			{
				content: "Perfeito, sobre qual carro você pensa?",
				conversationId: conversationAId,
				role: "assistant",
			},
		]);

		await openSessionChoice({
			askedAt: new Date(),
			conversationId: conversationAId,
			leadId,
		});

		await runNewConversation(conversationAId);

		const convs = await db
			.select({ id: conversations.id, status: conversations.status })
			.from(conversations)
			.where(eq(conversations.leadId, leadId));
		const b = convs.find((c) => c.status === "active");
		assert.ok(b);
		assert.notEqual(b.id, conversationAId);

		// The lead commercial state was reset by the "nova" branch.
		const [leadAfterReset] = await db
			.select({
				consortiumType: leads.consortiumType,
				objective: leads.objective,
			})
			.from(leads)
			.where(eq(leads.id, leadId));
		assert.equal(leadAfterReset?.objective, null);
		assert.equal(leadAfterReset?.consortiumType, null);

		// B receives the new customer message.
		await db.insert(messages).values({
			content: "quero consórcio de imóvel",
			conversationId: b.id,
			role: "user",
		});

		// Stub Gemini: capture exactly what the prompt and the stage receive.
		let capturedLead:
			| Parameters<typeof generateMarianaReply>[0]["lead"]
			| undefined;
		let capturedHistory:
			| Parameters<typeof generateMarianaReply>[0]["history"]
			| undefined;
		let capturedContext:
			| Parameters<typeof generateMarianaReply>[0]["conversationContext"]
			| undefined;

		await generateMarianaResponse({
			currentMessages: ["quero consórcio de imóvel"],
			generateMarianaReplyFn: async (params) => {
				capturedLead = params.lead;
				capturedHistory = params.history;
				capturedContext = params.conversationContext;
				return {
					metadata: { latencyMs: 1, model: "test-model", usage: null },
					result: {
						leadUpdate: { status: "qualifying" },
						nextAction: "continue_qualification",
						reply: "Certo! Vamos falar de imóvel.",
					},
				};
			},
			leadId,
			persistUserMessage: false,
		});

		assert.ok(capturedLead);
		assert.ok(capturedHistory);
		assert.ok(capturedContext);

		// No vehicle state reaches the model.
		assert.equal(capturedLead.objective, "");
		assert.equal(capturedLead.consortiumType, "");
		assert.equal(capturedLead.painPoint, null);

		// History is B-only: A's turns are not included.
		const historyContents = capturedHistory.map((m) => m.content);
		assert.equal(
			historyContents.includes("quero um consórcio de carro"),
			false
		);
		assert.equal(
			historyContents.includes("Perfeito, sobre qual carro você pensa?"),
			false
		);

		// B starts fresh: no assistant history, so the stage is `greeting`
		// and the backend asks the reason/objective question. It must NOT say
		// "não pergunte o tipo" (which would confirm vehicle state leaked).
		assert.equal(capturedContext.stage, "greeting");
		assert.notEqual(capturedContext.stage, "confirmation");
		assert.equal(
			capturedContext.doNotAsk.some((entry) =>
				entry.includes("não pergunte o tipo")
			),
			false
		);
		assert.equal(
			capturedContext.doNotAsk.some((entry) =>
				entry.includes("consórcio de carro")
			),
			false
		);
	} finally {
		await cleanup(leadId);
	}
});
