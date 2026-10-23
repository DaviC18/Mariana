import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { mock } from "node:test";

import {
	hashText,
	isPureBackendText,
	logTurnTrace,
	type RewriteRecord,
	type TurnTrace,
} from "../lib/turn-trace";

const ELEVEN_DIGITS = /\d{11}/;
const TWELVE_HEX = /^[0-9a-f]{12}$/;

function buildTrace(overrides: Partial<TurnTrace> = {}): TurnTrace {
	return {
		actionBlockedReason: null,
		commercialAccessLevel: 1,
		conversationId: "7c2b4e8a-1d6f-4b93-8a07-5e1c9d2f6b4a",
		executedAction: "continue_qualification",
		finishReason: "STOP",
		guardrailLayer: null,
		latencyMs: 1432,
		leadId: "b5e9a7c1-3f24-4d8e-9c60-1a7b4e2d8f53",
		maxOutputTokens: 1024,
		model: "gemini-3.5-flash-lite",
		modelVersionReturned: "gemini-3.5-flash-lite",
		outcome: "replied",
		postTurnStage: "consultant_offer",
		pureBackendText: false,
		questionKey: "consultantOffer",
		rawReplyHash: hashText("resposta crua"),
		rawReplyLength: 13,
		requestedNextAction: "continue_qualification",
		rewrites: [],
		rewritesReported: true,
		sentReplyHash: hashText("resposta enviada"),
		sentReplyLength: 16,
		stage: "info",
		temperature: 0.3,
		thinkingLevel: "LOW",
		turnId: "3f1a9c2e-4b7d-4a81-9e5c-2d6f8a0b1c3d",
		usage: {
			candidatesTokens: 96,
			promptTokens: 5871,
			thoughtsTokens: 212,
			totalTokens: 6179,
		},
		...overrides,
	};
}

function rewrite(
	layer: RewriteRecord["layer"],
	overrides: Partial<RewriteRecord> = {}
): RewriteRecord {
	return {
		hashAfter: hashText("depois"),
		hashBefore: hashText("antes"),
		layer,
		lengthAfter: 6,
		lengthBefore: 5,
		...overrides,
	};
}

test("logTurnTrace emite uma única linha JSON com event mariana_turn", () => {
	const info = mock.method(console, "info", () => {
		// Silencia a saída: só o argumento importa.
	});

	try {
		logTurnTrace(buildTrace());

		assert.equal(info.mock.callCount(), 1);

		const [line] = info.mock.calls[0].arguments;

		assert.equal(typeof line, "string");
		assert.equal((line as string).includes("\n"), false);

		const parsed = JSON.parse(line as string);

		assert.equal(parsed.event, "mariana_turn");
		assert.equal(parsed.turnId, "3f1a9c2e-4b7d-4a81-9e5c-2d6f8a0b1c3d");
		assert.equal(parsed.usage.thoughtsTokens, 212);
	} finally {
		info.mock.restore();
	}
});

test("o rastro nunca contém texto do cliente nem telefone", () => {
	const clientText = "meu telefone é 5531999999999";
	const reply = "Oi, Davi";
	const info = mock.method(console, "info", () => {
		// Silencia a saída.
	});

	try {
		logTurnTrace(
			buildTrace({
				rawReplyHash: hashText(reply),
				rawReplyLength: reply.length,
				rewrites: [
					rewrite("L1_identity_sanitizer", {
						hashAfter: hashText(reply),
						hashBefore: hashText(reply),
					}),
				],
				sentReplyHash: hashText(reply),
				sentReplyLength: reply.length,
			})
		);

		const line = info.mock.calls[0].arguments[0] as string;

		assert.equal(line.includes(clientText), false);
		assert.equal(line.includes("5531999999999"), false);
		assert.equal(line.includes(reply), false);
		assert.equal(ELEVEN_DIGITS.test(line), false);
	} finally {
		info.mock.restore();
	}
});

test("hashText é estável, hexadecimal e de 12 caracteres", () => {
	const hash = hashText("Oi, Davi");

	assert.equal(hash.length, 12);
	assert.match(hash, TWELVE_HEX);
	assert.equal(hash, hashText("Oi, Davi"));
	assert.equal(
		hash,
		createHash("sha256").update("Oi, Davi", "utf8").digest("hex").slice(0, 12)
	);
	assert.notEqual(hash, hashText("Oi, Davi."));
	assert.equal(hashText("").length, 12);
});

test("isPureBackendText detecta resposta 100% do backend", () => {
	// L9: a resposta do modelo era só pergunta e foi trocada pelo fallback
	// neutro do backend — nenhuma frase do modelo sobrevive.
	assert.equal(
		isPureBackendText(
			"E você, já pensou em consórcio?",
			"Posso te passar as informações que você precisar.",
			[
				rewrite("L9_neutral_fallback", {
					detail: { fallbackText: "neutral_1" },
				}),
			]
		),
		true
	);

	// L11: o texto do modelo foi inteiramente substituído pela oferta de
	// horários montada pelo backend.
	assert.equal(
		isPureBackendText(
			"Consigo te encaixar amanhã de manhã.",
			"Tenho estes horários: 1) 23/10 às 10h. 2) 23/10 às 14h.",
			[rewrite("L11_slot_offer_replaced")]
		),
		true
	);

	// L0: curto-circuito de nível 3, o modelo nunca foi chamado.
	assert.equal(
		isPureBackendText("", "Vou te colocar em contato com um consultor.", [
			rewrite("L0_level3_short_circuit"),
		]),
		true
	);

	// Camadas que só podam o texto do modelo não tornam a resposta do backend.
	assert.equal(
		isPureBackendText(
			"O consórcio funciona por grupos. E você, qual seu objetivo?",
			"O consórcio funciona por grupos.",
			[rewrite("L6_dropped_questions", { detail: { questionsDropped: 1 } })]
		),
		false
	);

	// Uma camada do conjunto, mas uma frase do modelo sobreviveu.
	assert.equal(
		isPureBackendText(
			"O consórcio funciona por grupos. Te passo os horários?",
			"O consórcio funciona por grupos. Tenho estes horários: 1) 23/10 às 10h.",
			[rewrite("L11_slot_offer_replaced")]
		),
		false
	);

	assert.equal(isPureBackendText("Oi, Davi", "Oi, Davi", []), false);
});
