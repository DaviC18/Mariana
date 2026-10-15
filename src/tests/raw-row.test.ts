import assert from "node:assert/strict";
import test from "node:test";

import { mapRawRow } from "../db/raw-row";
import { outboundMessages } from "../db/schema";

// Forma de uma linha crua de `db.execute(... RETURNING msg.*)` com o driver
// postgres-js do drizzle: timestamptz como string.
const rawOutboundRow = {
	attempts: 1,
	availableAt: "2026-10-14 22:13:26.527+00",
	conversationId: "7c251635-98c3-43f5-9afa-d0a57afaf808",
	createdAt: "2026-10-14 22:13:26.100123+00",
	eventId: null,
	id: "outbound-1",
	idempotencyKey: "mariana-reply:conversation:message",
	lastError: null,
	leadId: "lead-1",
	leaseExpiresAt: "2026-10-14 22:14:27.202+00",
	leaseToken: "lease-1",
	maxAttempts: 5,
	messageId: null,
	messageType: "text",
	payload: { kind: "text", text: "Olá" },
	providerMessageId: null,
	sentAt: null,
	status: "sending",
	updatedAt: "2026-10-14 22:13:27.202+00",
};

test("mapRawRow converte timestamptz em string para Date", () => {
	const message = mapRawRow(outboundMessages, rawOutboundRow);

	assert.ok(message.createdAt instanceof Date);
	assert.equal(message.createdAt.toISOString(), "2026-10-14T22:13:26.100Z");
	assert.ok(message.availableAt instanceof Date);
	assert.ok(message.leaseExpiresAt instanceof Date);
	assert.ok(message.updatedAt instanceof Date);
	assert.equal(message.sentAt, null);
	assert.equal(message.attempts, 1);
	assert.equal(message.status, "sending");
});

test("mapRawRow parseia jsonb que chega como texto", () => {
	const message = mapRawRow(outboundMessages, {
		...rawOutboundRow,
		payload: JSON.stringify(rawOutboundRow.payload),
	});
	assert.deepEqual(message.payload, rawOutboundRow.payload);
});

test("mapRawRow rejeita timestamp inválido", () => {
	assert.throws(
		() => mapRawRow(outboundMessages, { ...rawOutboundRow, createdAt: "nope" }),
		TypeError
	);
});

test("mapRawRow rejeita coluna NOT NULL ausente da linha", () => {
	const { createdAt: _createdAt, ...withoutCreatedAt } = rawOutboundRow;
	assert.throws(() => mapRawRow(outboundMessages, withoutCreatedAt), TypeError);
	const { payload: _payload, ...withoutPayload } = rawOutboundRow;
	assert.throws(() => mapRawRow(outboundMessages, withoutPayload), TypeError);
});

test("mapRawRow mantém null em coluna anulável ausente", () => {
	const { sentAt: _sentAt, ...withoutSentAt } = rawOutboundRow;
	assert.equal(mapRawRow(outboundMessages, withoutSentAt).sentAt, null);
});
