/** biome-ignore-all lint/suspicious/useAwait: mock assíncrono do Gemini */
/**
 * Regressão do incidente da conversa 7c251635-...: duas mensagens a 10s uma
 * da outra, no mesmo debounce (mesmo `batchCutoffAt`), geraram duas respostas.
 * Causa: o claim usa `db.execute(... RETURNING task.*)` e o driver postgres-js
 * do drizzle devolve `timestamptz` como string. Sem mapear a linha, a âncora
 * chegava ao handler com `createdAt` em string e o batch descartava a segunda
 * tarefa.
 *
 * Usa o claim e os handlers reais no Postgres de teste; só o Gemini é mockado.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { GenerateContentResponse } from "@google/genai";
import { eq } from "drizzle-orm";

import { ai } from "../../ai/client";
import { closeDatabase, db } from "../../db/connections";
import {
	autonomousTasks,
	conversations,
	leads,
	messages,
	outboundMessages,
} from "../../db/schema";
import { runAutonomousTasksUntilIdle } from "../../services/conversations/autonomous-task-executor";
import {
	createAutonomousTaskHandlers,
	PROCESS_INBOUND_MESSAGE_TASK,
} from "../../services/conversations/autonomous-task-handlers";

test.after(async () => {
	await closeDatabase();
});

const FIRST_TEXT = "ola Mariana boa noite";
const SECOND_TEXT = "Meu nome é Davi e eu quero fazer um consorcio";

test("duas mensagens no mesmo debounce geram uma única resposta", async (t) => {
	const geminiPrompts: string[] = [];
	t.mock.method(ai.models, "generateContent", async (request: unknown) => {
		geminiPrompts.push(JSON.stringify(request));
		return {
			text: JSON.stringify({
				businessAction: "ask_next_qualification_question",
				evidenceUsed: [],
				leadUpdate: { status: "qualifying" },
				nextAction: "continue_qualification",
				reply: "Boa noite, Davi! Vamos falar do seu consórcio.",
			}),
		} as GenerateContentResponse;
	});

	const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
	const [lead] = await db
		.insert(leads)
		.values({ name: `Lead Batch ${suffix}`, phone: `5521${suffix.slice(-9)}` })
		.returning({ id: leads.id });
	assert.ok(lead);
	t.after(async () => {
		await db.delete(leads).where(eq(leads.id, lead.id));
	});

	const [conversation] = await db
		.insert(conversations)
		.values({ lastCustomerMessageAt: new Date(), leadId: lead.id })
		.returning({ id: conversations.id });
	assert.ok(conversation);

	// Mesma forma do incidente, deslocada para o passado para a fila já
	// estar elegível: tarefas criadas a 10s uma da outra, cutoff comum.
	const firstAt = new Date(Date.now() - 60_000);
	const secondAt = new Date(firstAt.getTime() + 10_000);
	const cutoffAt = new Date(firstAt.getTime() + 25_000);

	const inbound = await db
		.insert(messages)
		.values([
			{
				content: FIRST_TEXT,
				conversationId: conversation.id,
				createdAt: firstAt,
				externalId: `wamid.batch1_${suffix}`,
				role: "user",
			},
			{
				content: SECOND_TEXT,
				conversationId: conversation.id,
				createdAt: secondAt,
				externalId: `wamid.batch2_${suffix}`,
				role: "user",
			},
		])
		.returning({ id: messages.id });
	assert.equal(inbound.length, 2);

	await db.insert(autonomousTasks).values(
		inbound.map((message, index) => ({
			availableAt: cutoffAt,
			conversationId: conversation.id,
			createdAt: index === 0 ? firstAt : secondAt,
			idempotencyKey: `inbound:batch${index + 1}_${suffix}`,
			payload: { batchCutoffAt: cutoffAt.toISOString(), kind: "text" },
			taskType: PROCESS_INBOUND_MESSAGE_TASK,
			triggerMessageId: message.id,
		}))
	);

	await runAutonomousTasksUntilIdle({
		conversationId: conversation.id,
		handlers: createAutonomousTaskHandlers(),
	});

	const replies = await db
		.select({ id: outboundMessages.id })
		.from(outboundMessages)
		.where(eq(outboundMessages.conversationId, conversation.id));
	assert.equal(replies.length, 1, "expected exactly one reply for the batch");

	const tasks = await db
		.select({ status: autonomousTasks.status })
		.from(autonomousTasks)
		.where(eq(autonomousTasks.conversationId, conversation.id));
	assert.deepEqual(
		tasks.map((task) => task.status),
		["completed", "completed"]
	);

	const replyPrompt = geminiPrompts.find(
		(prompt) => prompt.includes(FIRST_TEXT) && prompt.includes(SECOND_TEXT)
	);
	assert.ok(replyPrompt, "the single reply must cover both messages");
});
