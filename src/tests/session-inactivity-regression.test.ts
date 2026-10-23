import assert from "node:assert/strict";
import test from "node:test";
import { isSessionInactivityGap } from "../services/conversations/session-choice-policy";

test("regressão: inatividade exata de 24h e conversas sem histórico prévio", () => {
	const now = new Date("2026-10-23T10:00:00.000Z");
	const exactly24hAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

	assert.equal(
		isSessionInactivityGap({
			lastCustomerMessageAt: exactly24hAgo,
			now,
		}),
		true
	);

	// Caso de conversa nova sem lastCustomerMessageAt
	assert.equal(
		isSessionInactivityGap({
			lastCustomerMessageAt: null,
			now,
		}),
		false
	);
});
