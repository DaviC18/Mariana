import assert from "node:assert/strict";
import test, { mock } from "node:test";

import type { GenerateContentResponse } from "@google/genai";

import { generateMarianaReply, type MarianaLead } from "../ai/agent";
import { ai } from "../ai/client";
import { ModelUnavailableError } from "../ai/model-errors";
import { persistAuthorizedAssistantReply } from "../services/conversations/generateMarianaResponse";
import { MODEL_FAILURE_NOTICE } from "../services/conversations/model-failure-notice";
import { detectPendingOffer } from "../services/conversations/pending-offer";

const GUARDRAIL_MESSAGE = /guardrails/;

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

function buildParams(message: string) {
	return {
		currentMessages: [
			{ content: message, createdAt: new Date(), role: "user" as const },
		],
		history: [],
		lead: LEAD,
	};
}

function fakeResponse(text: string | undefined) {
	return { text } as unknown as GenerateContentResponse;
}

/** Rede nenhuma: o cliente real falha o teste em vez de sair para a API. */
function trapRealClient() {
	return mock.method(ai.models, "generateContent", () => {
		throw new Error("o cliente Gemini real não pode ser chamado neste teste");
	});
}

test("um erro de transporte do Gemini vira ModelUnavailableError", async () => {
	const trap = trapRealClient();
	// O erro do incidente N6: id de modelo inexistente.
	const transportError = Object.assign(
		new Error("models/gemini-3.6-flash-lite not found"),
		{ status: 404 }
	);

	try {
		await assert.rejects(
			() =>
				generateMarianaReply({
					...buildParams("como funciona o consórcio?"),
					generateContentFn: () => Promise.reject(transportError),
				}),
			(error: unknown) => {
				assert.ok(error instanceof ModelUnavailableError);
				assert.equal(error.kind, "transport");
				assert.equal(error.cause, transportError);
				return true;
			}
		);
	} finally {
		trap.mock.restore();
	}
});

test("resposta vazia e JSON inválido também viram ModelUnavailableError", async () => {
	const trap = trapRealClient();

	try {
		await assert.rejects(
			() =>
				generateMarianaReply({
					...buildParams("como funciona o consórcio?"),
					generateContentFn: () => Promise.resolve(fakeResponse(undefined)),
				}),
			(error: unknown) => {
				assert.ok(error instanceof ModelUnavailableError);
				assert.equal(error.kind, "empty_response");
				return true;
			}
		);

		await assert.rejects(
			() =>
				generateMarianaReply({
					...buildParams("como funciona o consórcio?"),
					generateContentFn: () =>
						Promise.resolve(fakeResponse("{ isso não é json")),
				}),
			(error: unknown) => {
				assert.ok(error instanceof ModelUnavailableError);
				assert.equal(error.kind, "invalid_json");
				assert.ok(error.cause instanceof Error);
				return true;
			}
		);
	} finally {
		trap.mock.restore();
	}
});

test("um erro de guardrail NÃO vira ModelUnavailableError", async () => {
	const trap = trapRealClient();

	try {
		await assert.rejects(
			() =>
				generateMarianaReply({
					...buildParams("como funciona o consórcio?"),
					generateContentFn: () =>
						Promise.resolve(
							fakeResponse(
								JSON.stringify({
									evidenceUsed: [],
									leadUpdate: { status: "qualifying" },
									nextAction: "continue_qualification",
									reply: "Somos a Ademicon. Seja bem-vindo à Ademicon.",
								})
							)
						),
				}),
			(error: unknown) => {
				assert.equal(error instanceof ModelUnavailableError, false);
				assert.match((error as Error).message, GUARDRAIL_MESSAGE);
				return true;
			}
		);
	} finally {
		trap.mock.restore();
	}
});

test("o aviso de falha não arma oferta pendente", () => {
	// Invariante do CLAUDE.md: a oferta pendente é marcada pelo backend e
	// nunca inferida de texto livre — o aviso não pode armá-la.
	assert.equal(detectPendingOffer(MODEL_FAILURE_NOTICE), null);
});

test("o aviso de falha não promete agendamento", async () => {
	// Se o texto carregasse promessa de agendamento, a autorização o trocaria.
	const prepared = await persistAuthorizedAssistantReply({
		actionResult: { action: "continue_qualification", status: "executed" },
		fallbackReply: "Qual é o seu objetivo?",
		persistAssistantMessage: (content: string) => Promise.resolve(content),
		reply: MODEL_FAILURE_NOTICE,
		requestedAction: "continue_qualification",
	});

	assert.equal(prepared.reply, MODEL_FAILURE_NOTICE);
	assert.deepEqual(prepared.rewrites, []);
});

test("o aviso é curto e em português", () => {
	// Texto aprovado por Davi, fixado: qualquer edição exige nova aprovação.
	assert.equal(
		MODEL_FAILURE_NOTICE,
		"Desculpe, tive uma falha técnica aqui e não consegui processar sua mensagem agora. Pode me enviar de novo em alguns instantes?"
	);
	assert.ok(
		MODEL_FAILURE_NOTICE.length <= 160,
		`o aviso tem ${MODEL_FAILURE_NOTICE.length} caracteres`
	);
});
