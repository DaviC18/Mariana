// Testes adversariais do tester para o Batch B de `2026-10-22-pkg-A`.
// Nenhum teste aqui abre rede ou banco: o seam `generateContentFn` é sempre
// usado e o cliente Gemini real fica armadilhado.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test, { mock } from "node:test";

import type { GenerateContentResponse } from "@google/genai";

import {
	generateMarianaReply,
	type MarianaLead,
	type TurnRewritesCarrier,
} from "../ai/agent";
import { ai } from "../ai/client";
import {
	hashText,
	isPureBackendText,
	type RewriteLayer,
	type RewriteRecord,
} from "../lib/turn-trace";
import { composeStageReplyWithTrace } from "../services/conversations/conversation-stage";

const REPO_ROOT = path.join(import.meta.dirname, "..", "..");
const TURN_TRACE_SOURCE = readFileSync(
	path.join(REPO_ROOT, "src", "lib", "turn-trace.ts"),
	"utf8"
);
const LAYER_ID_IN_SOURCE = /"(L\d{1,2}_[a-z0-9_]+)"/g;
const TWELVE_HEX = /^[0-9a-f]{12}$/;
const UNAVAILABLE_EVIDENCE = /unavailable knowledge evidence/;
const GUARDRAILS = /guardrails/;

// As doze camadas da auditoria §2.3 / `## Design` item 1, em ordem.
const AUDIT_LAYERS: RewriteLayer[] = [
	"L0_level3_short_circuit",
	"L1_identity_sanitizer",
	"L2_evidence_invalid_id",
	"L3_evidence_handoff",
	"L4_safety_assertion",
	"L5_request_consultant_override",
	"L6_dropped_questions",
	"L7_dropped_greeting",
	"L8_sentence_cap",
	"L9_neutral_fallback",
	"L10_unauthorized_scheduling",
	"L11_slot_offer_replaced",
];

// Resumo das 288 saídas de `composeStageReply` da versão anterior ao step 6,
// coletadas da implementação de HEAD. Se o refactor mudar um único byte de
// texto, ou a ordem das camadas, este hash quebra.
const STAGE_GOLDEN_DIGEST =
	"1cac965f10bf788b05fceef78b1556ad3b6abe55b859b7ecc5fbf625438ed7f4";

const GOLDEN_REPLIES = [
	"",
	"Oi, Davi! Tudo bem?",
	"Bom dia! O consórcio funciona por grupos. Quer que eu te explique?",
	"O consórcio funciona por grupos. A parcela é fixa. Não há juros. Existe taxa de administração.",
	"Desculpe!",
	"Desculpe, me perdi. Desculpa mesmo.",
	"E você, qual seu objetivo?",
	"Olá! Seja bem-vindo. Posso ajudar?",
	"Primeiro fato. Segundo fato. Terceiro fato. Quarto fato.",
	"   ",
	"Consigo te encaixar amanhã. Qual horário? Tenho 10h ou 14h?",
	"Oi! Oi! Oi!",
];
const GOLDEN_QUESTIONS = [null, "Qual o seu objetivo com o consórcio?"];
const GOLDEN_PREVIOUS = [
	null,
	undefined,
	"Posso te passar as informações que você precisar.",
];

const LEAD: MarianaLead = {
	commercialApproach: null,
	consortiumType: "carro",
	currentSituation: null,
	name: "Davi",
	objective: "comprar um carro",
	painPoint: null,
	status: "qualifying",
	urgency: null,
};

function fakeModelResponse(reply: string, evidenceUsed: string[] = []) {
	return {
		candidates: [{ finishReason: "STOP" }],
		modelVersion: "gemini-3.5-flash-lite-001",
		text: JSON.stringify({
			businessAction: "answer_basic_question",
			evidenceUsed,
			leadUpdate: { status: "qualifying" },
			nextAction: "continue_qualification",
			reply,
		}),
		usageMetadata: {},
	} as unknown as GenerateContentResponse;
}

function trapRealClient() {
	return mock.method(ai.models, "generateContent", () => {
		throw new Error("o cliente Gemini real não pode ser chamado neste teste");
	});
}

function runTurn(message: string, reply: string, evidenceUsed: string[] = []) {
	return generateMarianaReply({
		currentMessages: [
			{ content: message, createdAt: new Date(), role: "user" as const },
		],
		generateContentFn: () =>
			Promise.resolve(fakeModelResponse(reply, evidenceUsed)),
		history: [],
		lead: LEAD,
	});
}

function assertRecordIsConsistent(record: RewriteRecord, before: string) {
	assert.equal(record.lengthBefore, before.length);
	assert.equal(record.hashBefore, hashText(before));
	assert.match(record.hashAfter, TWELVE_HEX);
	assert.match(record.hashBefore, TWELVE_HEX);
}

test("as doze camadas do tipo são exatamente as da auditoria, sem nenhuma a menos", () => {
	const declared = [...TURN_TRACE_SOURCE.matchAll(LAYER_ID_IN_SOURCE)]
		.map((match) => match[1])
		.filter((id, index, all) => all.indexOf(id) === index)
		.sort();

	assert.deepEqual(declared, [...AUDIT_LAYERS].sort());
	assert.equal(new Set(AUDIT_LAYERS).size, 12);
});

test("L1 é registrada quando o saneador de identidade muda o texto", async () => {
	const trap = trapRealClient();
	const rawReply =
		"Seja bem-vindo à Ademicon. O consórcio funciona por grupos.";

	try {
		const { metadata } = await runTurn("como funciona o consórcio?", rawReply);
		const [record] = metadata.rewrites ?? [];

		assert.equal(metadata.rewrites?.length, 1);
		assert.equal(record.layer, "L1_identity_sanitizer");
		assertRecordIsConsistent(record, rawReply);
		assert.equal(metadata.rawReplyHash, hashText(rawReply));
		assert.notEqual(record.hashAfter, record.hashBefore);
	} finally {
		trap.mock.restore();
	}
});

test("L3 é registrada quando a validação de evidência troca a resposta", async () => {
	const trap = trapRealClient();
	// Pergunta de nível 2 com uma recomendação proibida: a validação devolve
	// o encaminhamento ao consultor em lugar do texto do modelo.
	const rawReply = "O lance é um valor. Recomendo um lance de 30%.";

	try {
		const { metadata, result } = await runTurn("o que e lance?", rawReply);
		const [record] = metadata.rewrites ?? [];

		assert.equal(metadata.rewrites?.length, 1);
		assert.equal(record.layer, "L3_evidence_handoff");
		assertRecordIsConsistent(record, rawReply);
		assert.equal(record.hashAfter, hashText(result.reply));
		assert.equal(record.lengthAfter, result.reply.length);
		assert.equal(metadata.commercialAccessLevel, 2);
	} finally {
		trap.mock.restore();
	}
});

test("L2 ainda lança e o erro carrega os registros parciais", async () => {
	const trap = trapRealClient();

	try {
		await assert.rejects(
			() =>
				runTurn(
					"como funciona o consórcio?",
					"Seja bem-vindo à Ademicon. O consórcio funciona por grupos.",
					["evidencia-que-nao-existe"]
				),
			(error: unknown) => {
				const carried = (error as Error & TurnRewritesCarrier).turnRewrites;

				assert.match((error as Error).message, UNAVAILABLE_EVIDENCE);
				// L1 rodou antes de L2 lançar: o registro tem de sobreviver no erro.
				assert.deepEqual(
					carried?.map((record) => record.layer),
					["L1_identity_sanitizer"]
				);
				return true;
			}
		);
	} finally {
		trap.mock.restore();
	}
});

test("L4 ainda lança e o erro carrega os registros parciais", async () => {
	const trap = trapRealClient();

	try {
		await assert.rejects(
			() =>
				runTurn(
					"como funciona o consórcio?",
					"Somos a Ademicon. Seja bem-vindo à Ademicon."
				),
			(error: unknown) => {
				const carried = (error as Error & TurnRewritesCarrier).turnRewrites;

				assert.match((error as Error).message, GUARDRAILS);
				assert.deepEqual(
					carried?.map((record) => record.layer),
					["L1_identity_sanitizer"]
				);
				return true;
			}
		);
	} finally {
		trap.mock.restore();
	}
});

test("composeStageReply continua byte-idêntico à versão anterior ao step 6", () => {
	const rows: { expected: string; layers: string[] }[] = [];

	for (const modelReply of GOLDEN_REPLIES) {
		for (const question of GOLDEN_QUESTIONS) {
			for (const previousAssistantMessage of GOLDEN_PREVIOUS) {
				for (const apologize of [false, true]) {
					for (const isFirstContact of [false, true]) {
						const traced = composeStageReplyWithTrace({
							apologize,
							isFirstContact,
							modelReply,
							previousAssistantMessage,
							question,
						});

						rows.push({
							expected: traced.reply,
							layers: traced.rewrites.map((record) => record.layer),
						});
					}
				}
			}
		}
	}

	assert.equal(rows.length, 288);
	assert.equal(
		createHash("sha256").update(JSON.stringify(rows), "utf8").digest("hex"),
		STAGE_GOLDEN_DIGEST
	);
});

test("nenhum detail das camadas de estágio carrega texto livre", () => {
	// A regra de privacidade do `## Design` item 1 vale no produtor, não só no
	// sumidouro: `detail` só aceita contagens e rótulos conhecidos.
	const allowedLabels = new Set(["neutral_1", "neutral_2"]);
	const clientPhone = "5531999999999";
	const modelReply = `Meu telefone é ${clientPhone}. Olá! Primeiro fato. Segundo fato. Terceiro fato. E você?`;

	const { rewrites } = composeStageReplyWithTrace({
		apologize: false,
		isFirstContact: false,
		modelReply,
		previousAssistantMessage: null,
		question: "Qual o seu objetivo?",
	});

	assert.ok(rewrites.length > 0);

	for (const record of rewrites) {
		for (const value of Object.values(record.detail ?? {})) {
			if (typeof value === "string") {
				assert.ok(
					allowedLabels.has(value),
					`detail trouxe texto livre: ${value}`
				);
			} else {
				assert.equal(Number.isFinite(value), true);
			}
		}

		assert.equal(JSON.stringify(record).includes(clientPhone), false);
		assert.equal(JSON.stringify(record).includes("Primeiro fato"), false);
	}
});

test("as camadas de estágio são registradas na ordem em que rodam", () => {
	const { rewrites } = composeStageReplyWithTrace({
		apologize: false,
		isFirstContact: false,
		modelReply:
			"Oi, Davi! Primeiro fato. Segundo fato. Terceiro fato. Quarto fato. Quer ver?",
		previousAssistantMessage: null,
		question: null,
	});

	assert.deepEqual(
		rewrites.map((record) => record.layer),
		["L6_dropped_questions", "L7_dropped_greeting", "L8_sentence_cap"]
	);
	assert.equal(rewrites[0].detail?.questionsDropped, 1);
	assert.equal(rewrites[1].detail?.greetingsDropped, 1);
	assert.equal(rewrites[2].detail?.cap, 3);
});

test("isPureBackendText não confunde poda com reescrita do backend", () => {
	// Uma camada que apenas poda nunca torna o texto 100% do backend.
	assert.equal(
		isPureBackendText("A. B. C?", "A. B.", [
			{
				hashAfter: hashText("A. B."),
				hashBefore: hashText("A. B. C?"),
				layer: "L8_sentence_cap",
				lengthAfter: 5,
				lengthBefore: 8,
			},
		]),
		false
	);

	// Sem nenhuma camada, nunca é texto do backend, mesmo com textos distintos.
	assert.equal(isPureBackendText("A.", "Z.", []), false);
});
