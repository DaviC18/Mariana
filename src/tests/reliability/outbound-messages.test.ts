/** biome-ignore-all lint/suspicious/useAwait: <> */
import assert from "node:assert/strict";
import test from "node:test";

import { eq } from "drizzle-orm";

import { closeDatabase, db } from "../../db/connections";
import { conversations } from "../../db/schema/conversations";
import { leads } from "../../db/schema/leads";
import { messages } from "../../db/schema/messages";
import { outboundMessages } from "../../db/schema/outbound-messages";
import { WhatsAppClient } from "../../integrations/whatsapp/whatsapp-client";
import { WhatsAppSendError } from "../../integrations/whatsapp/whatsapp-errors";
import { WhatsAppService } from "../../integrations/whatsapp/whatsapp-service";
import {
	claimNextOutboundMessage,
	enqueueOutboundMessage,
	executeNextOutboundMessage,
	type OutboundSender,
	recoverStaleOutboundMessages,
} from "../../services/messaging/outbound-messages";

test.after(async () => {
	await closeDatabase();
});

async function createFixture({ inCustomerWindow = true } = {}) {
	const [lead] = await db
		.insert(leads)
		.values({
			consortiumType: "geral",
			name: "Lead Teste Outbox",
			objective: "Teste de outbox",
			phone: `551199${Date.now()}${Math.floor(Math.random() * 1000)}`,
			status: "qualified",
		})
		.returning({ id: leads.id });

	assert.ok(lead);

	const [conversation] = await db
		.insert(conversations)
		.values({
			lastCustomerMessageAt: inCustomerWindow ? new Date() : null,
			leadId: lead.id,
		})
		.returning({ id: conversations.id });

	assert.ok(conversation);

	return { conversationId: conversation.id, leadId: lead.id };
}

async function cleanup(leadId: string, conversationId: string) {
	await db
		.delete(outboundMessages)
		.where(eq(outboundMessages.conversationId, conversationId));
	await db.delete(messages).where(eq(messages.conversationId, conversationId));
	await db.delete(conversations).where(eq(conversations.id, conversationId));
	await db.delete(leads).where(eq(leads.id, leadId));
}

function senderThatSends(id = "wamid.test"): OutboundSender {
	return {
		sendReplyButtonsMessage: async () => ({ messages: [{ id }] }),
		sendTextMessage: async () => ({ messages: [{ id }] }),
	};
}

function senderThatThrows(error: Error): OutboundSender {
	return {
		sendReplyButtonsMessage: async () => {
			throw error;
		},
		sendTextMessage: async () => {
			throw error;
		},
	};
}

async function getOutbound(id: string) {
	const [row] = await db
		.select()
		.from(outboundMessages)
		.where(eq(outboundMessages.id, id))
		.limit(1);
	assert.ok(row);
	return row;
}

test("enqueue é idempotente para a mesma chave lógica", async () => {
	const { conversationId, leadId } = await createFixture();

	try {
		const key = `outbox:dup:${Date.now()}`;

		const first = await enqueueOutboundMessage({
			conversationId,
			idempotencyKey: key,
			leadId,
			payload: { kind: "text", text: "primeira" },
		});
		const second = await enqueueOutboundMessage({
			conversationId,
			idempotencyKey: key,
			leadId,
			payload: { kind: "text", text: "segunda" },
		});

		assert.ok(first);
		assert.equal(second?.id, first.id);

		const rows = await db
			.select({ id: outboundMessages.id })
			.from(outboundMessages)
			.where(eq(outboundMessages.idempotencyKey, key));

		assert.equal(rows.length, 1);
	} finally {
		await cleanup(leadId, conversationId);
	}
});

test("envia mensagem de texto, marca como sent e grava o WAMID na mensagem", async () => {
	const { conversationId, leadId } = await createFixture();

	try {
		const [assistantMessage] = await db
			.insert(messages)
			.values({ content: "Olá!", conversationId, role: "assistant" })
			.returning({ id: messages.id });
		assert.ok(assistantMessage);

		const message = await enqueueOutboundMessage({
			conversationId,
			idempotencyKey: `outbox:send:${Date.now()}`,
			leadId,
			messageId: assistantMessage.id,
			payload: { kind: "text", text: "Olá!" },
		});
		assert.ok(message);

		const result = await executeNextOutboundMessage({
			conversationId,
			sender: senderThatSends("wamid.resposta"),
		});

		assert.equal(result.status, "sent");

		const saved = await getOutbound(message.id);
		assert.equal(saved.status, "sent");
		assert.equal(saved.providerMessageId, "wamid.resposta");
		assert.equal(saved.leaseToken, null);

		const [savedMessage] = await db
			.select({ externalId: messages.externalId })
			.from(messages)
			.where(eq(messages.id, assistantMessage.id))
			.limit(1);

		assert.equal(savedMessage?.externalId, "wamid.resposta");
	} finally {
		await cleanup(leadId, conversationId);
	}
});

test("reagenda com backoff em falha retryável da API", async () => {
	const { conversationId, leadId } = await createFixture();

	try {
		const message = await enqueueOutboundMessage({
			conversationId,
			idempotencyKey: `outbox:retry:${Date.now()}`,
			leadId,
			maxAttempts: 5,
			payload: { kind: "text", text: "retry" },
		});
		assert.ok(message);

		const result = await executeNextOutboundMessage({
			conversationId,
			sender: senderThatThrows(
				new WhatsAppSendError({
					httpStatus: 503,
					kind: "retryable",
					message: "transient",
				})
			),
		});

		assert.equal(result.status, "retry_scheduled");

		const saved = await getOutbound(message.id);
		assert.equal(saved.status, "pending");
		assert.equal(saved.attempts, 1);
		assert.ok(saved.availableAt.getTime() > Date.now() - 1000);
	} finally {
		await cleanup(leadId, conversationId);
	}
});

test("falha em definitivo em erro permanente da API", async () => {
	const { conversationId, leadId } = await createFixture();

	try {
		const message = await enqueueOutboundMessage({
			conversationId,
			idempotencyKey: `outbox:fail:${Date.now()}`,
			leadId,
			payload: { kind: "text", text: "fail" },
		});
		assert.ok(message);

		const result = await executeNextOutboundMessage({
			conversationId,
			sender: senderThatThrows(
				new WhatsAppSendError({
					httpStatus: 400,
					kind: "permanent",
					message: "bad request",
				})
			),
		});

		assert.equal(result.status, "failed");

		const saved = await getOutbound(message.id);
		assert.equal(saved.status, "failed");
	} finally {
		await cleanup(leadId, conversationId);
	}
});

test("marca como unknown em resultado incerto sem reenviar", async () => {
	const { conversationId, leadId } = await createFixture();

	try {
		const message = await enqueueOutboundMessage({
			conversationId,
			idempotencyKey: `outbox:unknown:${Date.now()}`,
			leadId,
			payload: { kind: "text", text: "unknown" },
		});
		assert.ok(message);

		const result = await executeNextOutboundMessage({
			conversationId,
			sender: senderThatThrows(
				new WhatsAppSendError({ kind: "uncertain", message: "network" })
			),
		});

		assert.equal(result.status, "unknown");

		const saved = await getOutbound(message.id);
		assert.equal(saved.status, "unknown");
	} finally {
		await cleanup(leadId, conversationId);
	}
});

test("bloqueia envio fora da janela do cliente e não chama a API", async () => {
	const { conversationId, leadId } = await createFixture({
		inCustomerWindow: false,
	});

	try {
		const message = await enqueueOutboundMessage({
			conversationId,
			idempotencyKey: `outbox:blocked:${Date.now()}`,
			leadId,
			payload: { kind: "text", text: "proativo" },
		});
		assert.ok(message);

		let sendCalls = 0;
		const result = await executeNextOutboundMessage({
			conversationId,
			sender: {
				sendReplyButtonsMessage: async () => {
					sendCalls += 1;
					return { messages: [{ id: "x" }] };
				},
				sendTextMessage: async () => {
					sendCalls += 1;
					return { messages: [{ id: "x" }] };
				},
			},
		});

		assert.equal(result.status, "failed");
		assert.equal(sendCalls, 0);

		const saved = await getOutbound(message.id);
		assert.equal(saved.status, "failed");
	} finally {
		await cleanup(leadId, conversationId);
	}
});

test("recupera mensagens presas em sending como unknown", async () => {
	const { conversationId, leadId } = await createFixture();

	try {
		const message = await enqueueOutboundMessage({
			conversationId,
			idempotencyKey: `outbox:stale:${Date.now()}`,
			leadId,
			payload: { kind: "text", text: "stale" },
		});
		assert.ok(message);

		await db
			.update(outboundMessages)
			.set({
				leaseExpiresAt: new Date(Date.now() - 60_000),
				leaseToken: "00000000-0000-4000-8000-000000000010",
				status: "sending",
			})
			.where(eq(outboundMessages.id, message.id));

		const recovered = await recoverStaleOutboundMessages();

		assert.ok(recovered >= 1);

		const saved = await getOutbound(message.id);
		assert.equal(saved.status, "unknown");
	} finally {
		await cleanup(leadId, conversationId);
	}
});

test("claim do outbox devolve timestamps como Date e payload como objeto", async () => {
	const { conversationId, leadId } = await createFixture();
	try {
		await enqueueOutboundMessage({
			conversationId,
			idempotencyKey: `claim-types:${conversationId}`,
			leadId,
			payload: { kind: "text", text: "Olá" },
		});

		const claimed = await claimNextOutboundMessage({
			conversationId,
			leaseMs: 60_000,
		});

		assert.ok(claimed);
		assert.ok(claimed.createdAt instanceof Date, "createdAt");
		assert.ok(claimed.availableAt instanceof Date, "availableAt");
		assert.ok(claimed.updatedAt instanceof Date, "updatedAt");
		assert.ok(claimed.leaseExpiresAt instanceof Date, "leaseExpiresAt");
		assert.equal(claimed.sentAt, null);
		assert.deepEqual(claimed.payload, { kind: "text", text: "Olá" });
	} finally {
		await cleanup(leadId, conversationId);
	}
});

test("envio pendurado na Graph API termina em unknown antes do lease e não é reenviado", async (t) => {
	const { conversationId, leadId } = await createFixture();
	t.after(() => cleanup(leadId, conversationId));

	const originalFetch = globalThis.fetch;
	let fetchCalls = 0;
	// Nunca resolve e ignora o AbortSignal.
	globalThis.fetch = (() => {
		fetchCalls += 1;
		return new Promise<Response>(() => undefined);
	}) as typeof fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});

	const queued = await enqueueOutboundMessage({
		conversationId,
		idempotencyKey: `hang:${conversationId}`,
		leadId,
		payload: { kind: "text", text: "Olá" },
	});
	assert.ok(queued);

	const leaseMs = 2000;
	const sender = new WhatsAppService(
		new WhatsAppClient({ sendTimeoutMs: 100 })
	);
	const startedAt = Date.now();
	const result = await Promise.race([
		executeNextOutboundMessage({ conversationId, leaseMs, sender }),
		new Promise<never>((_, reject) => {
			setTimeout(
				() => reject(new Error("worker still blocked after the lease")),
				leaseMs
			).unref();
		}),
	]);

	assert.ok(Date.now() - startedAt < leaseMs, "worker released before lease");
	assert.equal(result.status, "unknown");

	const row = await getOutbound(queued.id);
	assert.equal(row.status, "unknown");
	assert.equal(row.attempts, 1);
	assert.equal(row.leaseToken, null);

	const next = await executeNextOutboundMessage({
		conversationId,
		leaseMs,
		sender,
	});
	assert.equal(next.status, "idle");
	assert.equal(fetchCalls, 1);
	assert.equal((await getOutbound(queued.id)).status, "unknown");
});
