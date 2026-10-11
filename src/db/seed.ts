import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { closeDatabase, db } from "./connections";
import { autonomousTasks, conversations, leads, messages } from "./schema";

async function main() {
	let testLeadId: string | undefined;

	try {
		console.log("🧪 Testing autonomous task persistence...");

		const runId = randomUUID();

		// 1. Criar um lead isolado para o teste.
		const [lead] = await db
			.insert(leads)
			.values({
				name: "Teste de tarefa autônoma",
				phone: `autonomous-test-${runId}`,
				status: "new",
			})
			.returning({ id: leads.id });

		if (!lead) {
			throw new Error("Não foi possível criar o lead de teste");
		}

		testLeadId = lead.id;

		// 2. Criar a conversa.
		const [conversation] = await db
			.insert(conversations)
			.values({
				leadId: lead.id,
				status: "active",
			})
			.returning({ id: conversations.id });

		if (!conversation) {
			throw new Error("Não foi possível criar a conversa de teste");
		}

		// 3. Criar a mensagem que inicia o fluxo.
		const [triggerMessage] = await db
			.insert(messages)
			.values({
				content: "Olá, quero falar com um consultor.",
				conversationId: conversation.id,
				externalId: `autonomous-test-${runId}`,
				role: "user",
			})
			.returning({
				conversationId: messages.conversationId,
				id: messages.id,
			});

		if (!triggerMessage) {
			throw new Error("Não foi possível criar a mensagem de teste");
		}

		// 4. Registrar a tarefa autônoma.
		const [createdTask] = await db
			.insert(autonomousTasks)
			.values({
				conversationId: triggerMessage.conversationId,
				idempotencyKey: `autonomous-test:${runId}`,
				payload: {
					purpose: "verify_autonomous_task_persistence",
					source: "isolated-test",
				},
				taskType: "process_inbound",
				triggerMessageId: triggerMessage.id,
			})
			.returning();

		if (!createdTask) {
			throw new Error("A tarefa autônoma não foi criada");
		}

		// 5. Consultar novamente o banco.
		const [persistedTask] = await db
			.select()
			.from(autonomousTasks)
			.where(eq(autonomousTasks.id, createdTask.id))
			.limit(1);

		if (
			persistedTask?.status !== "pending" ||
			persistedTask.triggerMessageId !== triggerMessage.id ||
			persistedTask.conversationId !== conversation.id
		) {
			throw new Error(
				"A tarefa persistida não corresponde aos dados esperados"
			);
		}

		console.log("✅ Autonomous task persistence verified", {
			id: persistedTask.id,
			status: persistedTask.status,
			taskType: persistedTask.taskType,
			workflowId: persistedTask.workflowId,
		});
	} finally {
		// A exclusão do lead remove os registros dependentes
		// pelas relações com ON DELETE CASCADE.
		if (testLeadId) {
			await db.delete(leads).where(eq(leads.id, testLeadId));
		}
	}
}

main()
	.catch((error) => {
		console.error("❌ Autonomous task test failed:");
		console.error(error);
		process.exitCode = 1;
	})
	.finally(async () => {
		await closeDatabase();
	});
