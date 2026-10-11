import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { closeDatabase, db } from "./connections";
import { autonomousTasks, conversations, leads, messages } from "./schema";

async function main() {
	let testLeadId: string | undefined;

	try {
		console.log("Testing autonomous task persistence...");

		const runId = randomUUID();

		const [lead] = await db
			.insert(leads)
			.values({
				name: "Teste de tarefa autônoma",
				phone: `autonomous-test-${runId}`,
				status: "new",
			})
			.returning({ id: leads.id });

		if (!lead) {
			throw new Error("Falha ao criar lead de teste");
		}
		testLeadId = lead.id;

		const [conversation] = await db
			.insert(conversations)
			.values({
				leadId: lead.id,
				status: "active",
			})
			.returning({ id: conversations.id });

		if (!conversation) {
			throw new Error("Falha ao criar conversa");
		}

		const [message] = await db
			.insert(messages)
			.values({
				content: "Mensagem de teste",
				conversationId: conversation.id,
				externalId: `autonomous-test-${runId}`,
				role: "user",
			})
			.returning({ id: messages.id });

		if (!message) {
			throw new Error("Falha ao criar mensagem");
		}

		const [task] = await db
			.insert(autonomousTasks)
			.values({
				conversationId: conversation.id,
				idempotencyKey: `autonomous-test:${runId}`,
				payload: { source: "isolated-test" },
				taskType: "process_inbound",
				triggerMessageId: message.id,
			})
			.returning();

		if (!task) {
			throw new Error("Falha ao criar tarefa");
		}

		const [persisted] = await db
			.select()
			.from(autonomousTasks)
			.where(eq(autonomousTasks.id, task.id))
			.limit(1);

		if (
			persisted?.status !== "pending" ||
			persisted.conversationId !== conversation.id ||
			persisted.triggerMessageId !== message.id
		) {
			throw new Error("Os dados persistidos não correspondem ao esperado");
		}

		console.log("Persistence test passed:", {
			id: persisted.id,
			status: persisted.status,
			taskType: persisted.taskType,
			workflowId: persisted.workflowId,
		});
	} finally {
		if (testLeadId) {
			await db.delete(leads).where(eq(leads.id, testLeadId));
		}
	}
}

main()
	.catch((error) => {
		console.error("Persistence test failed:", error);
		process.exitCode = 1;
	})
	.finally(async () => {
		await closeDatabase();
	});
