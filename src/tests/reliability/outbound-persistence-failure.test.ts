/** biome-ignore-all lint/suspicious/useAwait: <> */
/** biome-ignore-all lint/suspicious/noThenProperty: fake drizzle builders must be awaitable */

// Testes isolados: todas as chamadas ao `db` são substituídas por mocks, então
// nenhum dado é lido ou escrito no banco. Rode com um DATABASE_URL inalcançável
// para garantir isso, por exemplo:
//   DATABASE_URL=postgresql://isolated:isolated@127.0.0.1:1/isolated \
//     npx tsx --test src/tests/reliability/outbound-persistence-failure.test.ts

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { getTableName, type Table } from "drizzle-orm";

import { db } from "../../db/connections";
import {
	executeNextOutboundMessage,
	type OutboundSender,
} from "../../services/messaging/outbound-messages";

const LEASE_TOKEN = "00000000-0000-4000-8000-000000000001";
const PERSISTENCE_ERROR_PATTERN = /persist/i;

interface RecordedUpdate {
	table: string;
	values: Record<string, unknown>;
}

function awaitableBuilder(resolve: () => Promise<unknown>) {
	const builder: Record<string, unknown> = {
		then: (
			onFulfilled: (value: unknown) => unknown,
			onRejected: (reason: unknown) => unknown
		) => resolve().then(onFulfilled, onRejected),
	};
	for (const method of ["from", "where", "limit", "returning"]) {
		builder[method] = () => builder;
	}
	return builder;
}

function claimedRow() {
	const now = new Date();
	return {
		attempts: 1,
		availableAt: now,
		conversationId: "00000000-0000-4000-8000-0000000000c1",
		createdAt: now,
		eventId: null,
		id: "00000000-0000-4000-8000-0000000000a1",
		idempotencyKey: "outbox:persistence-failure",
		lastError: null,
		leadId: "00000000-0000-4000-8000-0000000000b1",
		leaseExpiresAt: new Date(now.getTime() + 60_000),
		leaseToken: LEASE_TOKEN,
		maxAttempts: 5,
		messageId: "00000000-0000-4000-8000-0000000000d1",
		messageType: "text",
		payload: { kind: "text", text: "olá" },
		providerMessageId: null,
		sentAt: null,
		status: "sending",
		updatedAt: now,
	};
}

/**
 * Simula o banco: o claim devolve uma linha em `sending`, lead e conversa
 * existem e estão na janela de atendimento. `onUpdate` decide o resultado de
 * cada UPDATE, na ordem em que acontecem.
 */
function mockDatabase(
	t: TestContext,
	onUpdate: (update: RecordedUpdate, index: number) => Promise<unknown>
) {
	const updates: RecordedUpdate[] = [];

	t.mock.method(db, "execute", async () => [claimedRow()]);
	t.mock.method(db, "select", () =>
		awaitableBuilder(async () => [
			{
				lastCustomerMessageAt: new Date(),
				optOutAt: null,
				phone: "5511999999999",
			},
		])
	);
	t.mock.method(db, "update", (table: Table) => ({
		set: (values: Record<string, unknown>) => {
			const update = { table: getTableName(table), values };
			const index = updates.push(update) - 1;
			return awaitableBuilder(() => onUpdate(update, index));
		},
	}));

	return updates;
}

function countingSender(id = "wamid.persist-test") {
	const calls = { count: 0 };
	const sender: OutboundSender = {
		sendReplyButtonsMessage: async () => {
			calls.count += 1;
			return { messages: [{ id }] };
		},
		sendTextMessage: async () => {
			calls.count += 1;
			return { messages: [{ id }] };
		},
	};
	return { calls, sender };
}

function silenceConsoleError(t: TestContext) {
	t.mock.method(console, "error", () => undefined);
}

function assertNeverRequeued(updates: RecordedUpdate[]) {
	for (const update of updates) {
		assert.notEqual(
			update.values.status,
			"pending",
			"mensagem já aceita pelo WhatsApp não pode voltar para pending"
		);
	}
}

test("falha ao gravar sent após envio aceito não reenfileira e marca unknown com o WAMID", async (t) => {
	silenceConsoleError(t);
	const updates = mockDatabase(t, async (update, index) => {
		if (index === 0) {
			assert.equal(update.values.status, "sent");
			throw new Error("connection terminated unexpectedly");
		}
		return [{ id: claimedRow().id }];
	});
	const { calls, sender } = countingSender();

	const result = await executeNextOutboundMessage({ sender });

	assert.equal(calls.count, 1);
	assert.equal(result.status, "unknown");
	assertNeverRequeued(updates);

	const [, fallback] = updates;
	assert.ok(fallback, "deve tentar registrar o resultado como unknown");
	assert.equal(fallback.table, "outbound_messages");
	assert.equal(fallback.values.status, "unknown");
	assert.equal(fallback.values.providerMessageId, "wamid.persist-test");
	assert.match(String(fallback.values.lastError), PERSISTENCE_ERROR_PATTERN);
});

test("se o registro de unknown também falhar, a linha fica em sending para a recuperação de lease", async (t) => {
	silenceConsoleError(t);
	const updates = mockDatabase(t, async () => {
		throw new Error("database unavailable");
	});
	const { calls, sender } = countingSender();

	const result = await executeNextOutboundMessage({ sender });

	assert.equal(calls.count, 1);
	assert.equal(result.status, "unknown");
	assertNeverRequeued(updates);
});

test("falha ao vincular o WAMID à mensagem do assistente mantém o envio como sent", async (t) => {
	silenceConsoleError(t);
	const updates = mockDatabase(t, async (update) => {
		if (update.table === "messages") {
			throw new Error("connection terminated unexpectedly");
		}
		return [{ id: claimedRow().id }];
	});
	const { calls, sender } = countingSender();

	const result = await executeNextOutboundMessage({ sender });

	assert.equal(calls.count, 1);
	assert.equal(result.status, "sent");
	assertNeverRequeued(updates);
	assert.deepEqual(
		updates.map((update) => [update.table, update.values.status]),
		[
			["outbound_messages", "sent"],
			["messages", undefined],
		]
	);
});
