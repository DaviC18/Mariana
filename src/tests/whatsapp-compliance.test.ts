import assert from "node:assert/strict";
import test from "node:test";

import {
	evaluateWhatsAppOutbound,
	isOptOutRequest,
	WHATSAPP_CUSTOMER_WINDOW_MS,
} from "../services/conversations/whatsapp-compliance";

const now = new Date("2026-10-08T12:00:00.000Z");

test("permite resposta livre dentro da janela iniciada pelo cliente", () => {
	assert.deepEqual(
		evaluateWhatsAppOutbound({
			at: now,
			kind: "free_form",
			lastCustomerMessageAt: new Date(
				now.getTime() - WHATSAPP_CUSTOMER_WINDOW_MS + 1
			),
			optOutAt: null,
		}),
		{ allowed: true }
	);
});

test("bloqueia contato proativo sem consentimento e texto livre após 24h", () => {
	const oldMessage = new Date(now.getTime() - WHATSAPP_CUSTOMER_WINDOW_MS - 1);
	assert.equal(
		evaluateWhatsAppOutbound({
			at: now,
			kind: "free_form",
			lastCustomerMessageAt: null,
			optOutAt: null,
		}).reason,
		"missing_proactive_consent"
	);
	assert.equal(
		evaluateWhatsAppOutbound({
			at: now,
			hasConsent: true,
			kind: "free_form",
			lastCustomerMessageAt: oldMessage,
			optOutAt: null,
		}).reason,
		"customer_window_closed_template_required"
	);
	assert.equal(
		evaluateWhatsAppOutbound({
			at: now,
			hasConsent: true,
			kind: "approved_template",
			lastCustomerMessageAt: oldMessage,
			optOutAt: null,
		}).allowed,
		true
	);
});

test("detecta opt-out explícito e bloqueia qualquer novo envio", () => {
	assert.equal(isOptOutRequest("Por favor, pare de me mandar mensagens"), true);
	assert.equal(isOptOutRequest("quero entender como funciona"), false);
	assert.deepEqual(
		evaluateWhatsAppOutbound({
			at: now,
			kind: "approved_template",
			lastCustomerMessageAt: now,
			optOutAt: now,
		}),
		{ allowed: false, reason: "contact_opted_out" }
	);
});
