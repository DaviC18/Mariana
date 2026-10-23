import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
	hasPreviousCustomerMessage,
	isSessionInactivityGap,
	SESSION_CHOICE_ALREADY_RECORDED_TEXT,
	SESSION_CHOICE_CONTINUE_BUTTON_ID,
	SESSION_CHOICE_CONTINUE_BUTTON_TITLE,
	SESSION_CHOICE_NEW_BUTTON_ID,
	SESSION_CHOICE_NEW_BUTTON_TITLE,
	SESSION_CHOICE_NEW_CONVERSATION_CONFIRMATION_TEXT,
	SESSION_CHOICE_PENDING_INVALID_REPLY_TEXT,
	SESSION_CHOICE_QUESTION_TEXT,
	SESSION_CHOICE_REMINDER_TEXT,
	SESSION_INACTIVITY_MS,
} from "../services/conversations/session-choice-policy";

const DAY_MS = 24 * 60 * 60 * 1000;
const WHATSAPP_COMPLIANCE_IMPORT = /from\s+["'][^"']*whatsapp-compliance["']/;

test("24h exatas contam como inatividade, 24h menos 1 ms não", () => {
	const now = new Date("2026-10-22T12:00:00.000Z");

	assert.equal(
		isSessionInactivityGap({
			lastCustomerMessageAt: new Date(now.getTime() - DAY_MS),
			now,
		}),
		true
	);
	assert.equal(
		isSessionInactivityGap({
			lastCustomerMessageAt: new Date(now.getTime() - DAY_MS + 1),
			now,
		}),
		false
	);
});

test("timestamp nulo ou inválido não prova inatividade", () => {
	const now = new Date("2026-10-22T12:00:00.000Z");

	assert.equal(
		isSessionInactivityGap({ lastCustomerMessageAt: null, now }),
		false
	);
	assert.equal(
		isSessionInactivityGap({
			lastCustomerMessageAt: new Date("invalid"),
			now,
		}),
		false
	);
	assert.doesNotThrow(() => {
		isSessionInactivityGap({ lastCustomerMessageAt: null, now });
	});
});

test("timestamp futuro, relógio inválido ou valor não-Date não provam inatividade", () => {
	const now = new Date("2026-10-22T12:00:00.000Z");

	// Relógio do provedor adiantado (ou mensagem gravada no futuro) não pode
	// virar "gap negativo" e disparar a pergunta.
	assert.equal(
		isSessionInactivityGap({
			lastCustomerMessageAt: new Date(now.getTime() + DAY_MS),
			now,
		}),
		false
	);
	assert.equal(
		isSessionInactivityGap({
			lastCustomerMessageAt: now,
			now: new Date("invalid"),
		}),
		false
	);
	assert.equal(
		isSessionInactivityGap({ lastCustomerMessageAt: undefined, now }),
		false
	);
	// Contrato de tipo: o módulo não converte string (ex.: coluna lida como
	// texto) em data; sem Date válido não há prova de 24h.
	assert.equal(
		isSessionInactivityGap({
			lastCustomerMessageAt: new Date(
				now.getTime() - DAY_MS
			).toISOString() as unknown as Date,
			now,
		}),
		false
	);
});

test("a pergunta de 24h só aparece quando o cliente já escreveu antes", () => {
	assert.equal(hasPreviousCustomerMessage({ customerMessageCount: 1 }), true);
	assert.equal(hasPreviousCustomerMessage({ customerMessageCount: 40 }), true);
	for (const empty of [0, null, undefined, Number.NaN]) {
		assert.equal(
			hasPreviousCustomerMessage({ customerMessageCount: empty }),
			false
		);
	}
});

test("textos e IDs da escolha são estáveis e curtos", () => {
	assert.equal(
		SESSION_CHOICE_QUESTION_TEXT,
		"Oi! Já passou mais de 24 horas desde a nossa última conversa. Você prefere continuar de onde paramos ou começar uma conversa nova?"
	);
	assert.equal(
		SESSION_CHOICE_REMINDER_TEXT,
		"Só para eu não misturar os assuntos: você quer continuar a conversa anterior ou começar uma nova?"
	);
	assert.equal(
		SESSION_CHOICE_NEW_CONVERSATION_CONFIRMATION_TEXT,
		"Pronto, comecei uma conversa nova. Pode me contar o que você procura agora."
	);
	assert.equal(
		SESSION_CHOICE_PENDING_INVALID_REPLY_TEXT,
		"Antes de seguir, preciso da sua escolha: continuar a conversa anterior ou começar uma nova?"
	);
	assert.equal(
		SESSION_CHOICE_ALREADY_RECORDED_TEXT,
		"Sua escolha já foi registrada. Vou seguir por ela."
	);

	assert.equal(SESSION_CHOICE_CONTINUE_BUTTON_ID, "sessao:continuar");
	assert.equal(SESSION_CHOICE_NEW_BUTTON_ID, "sessao:nova");
	assert.equal(SESSION_CHOICE_CONTINUE_BUTTON_TITLE, "Continuar");
	assert.equal(SESSION_CHOICE_NEW_BUTTON_TITLE, "Nova conversa");
	assert.ok(SESSION_CHOICE_CONTINUE_BUTTON_TITLE.length <= 20);
	assert.ok(SESSION_CHOICE_NEW_BUTTON_TITLE.length <= 20);
});

test("a janela de sessão não reutiliza a janela do WhatsApp", () => {
	assert.equal(SESSION_INACTIVITY_MS, DAY_MS);

	const source = readFileSync(
		path.join(
			import.meta.dirname,
			"..",
			"services",
			"conversations",
			"session-choice-policy.ts"
		),
		"utf8"
	);

	assert.equal(WHATSAPP_COMPLIANCE_IMPORT.test(source), false);
});
