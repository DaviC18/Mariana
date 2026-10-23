import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test, { mock } from "node:test";

import { type GenerateContentResponse, ThinkingLevel } from "@google/genai";
import { z } from "zod";

import {
	buildModelRequestConfig,
	generateMarianaReply,
	type MarianaLead,
	resolveModelName,
	type TurnRewritesCarrier,
} from "../ai/agent";
import { ai } from "../ai/client";
import { marianaResponseSchema } from "../ai/schemas/mariana-response-schema";
import { env } from "../env";
import { hashText } from "../lib/turn-trace";

const HARD_CODED_MODEL = /const\s+MODEL\s*=\s*["'`]gemini-/;

test("buildModelRequestConfig envia modelo, temperatura, nível de raciocínio e limite de saída", () => {
	const config = buildModelRequestConfig({
		systemInstruction: "prompt de sistema",
	});

	// Os defaults aprovados são fixados em `env.test.ts`, contra uma fonte
	// explícita. Aqui comparamos com o ambiente ativo: afinar o `.env` é o
	// objetivo da feature e não pode deixar a suíte vermelha.
	assert.equal(config.temperature, env.GEMINI_TEMPERATURE);
	assert.equal(config.maxOutputTokens, env.GEMINI_MAX_OUTPUT_TOKENS);
	assert.equal(
		config.thinkingConfig?.thinkingLevel,
		ThinkingLevel[env.GEMINI_THINKING_LEVEL]
	);
	assert.equal(config.responseMimeType, "application/json");
	assert.equal(config.systemInstruction, "prompt de sistema");
	assert.deepEqual(
		config.responseJsonSchema,
		z.toJSONSchema(marianaResponseSchema)
	);
});

test("o modelo vem do ambiente, não de uma constante", () => {
	assert.equal(resolveModelName(), env.GEMINI_MODEL);

	const source = readFileSync(
		path.join(import.meta.dirname, "..", "ai", "agent.ts"),
		"utf8"
	);

	assert.equal(HARD_CODED_MODEL.test(source), false);
});

const FAKE_REPLY = "Texto A. Texto B?";

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
		usageMetadata: {
			candidatesTokenCount: 96,
			promptTokenCount: 5871,
			thoughtsTokenCount: 212,
			totalTokenCount: 6179,
		},
	} as unknown as GenerateContentResponse;
}

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

function trapRealClient() {
	// Rede nenhuma: se o seam `generateContentFn` quebrar, o teste falha em
	// vez de sair para a API do Gemini.
	return mock.method(ai.models, "generateContent", () => {
		throw new Error("o cliente Gemini real não pode ser chamado neste teste");
	});
}

test("metadata traz hash e comprimento da resposta crua", async () => {
	const trap = trapRealClient();
	let calls = 0;
	const { metadata } = await generateMarianaReply({
		...buildParams("como funciona o consórcio?"),
		generateContentFn: () => {
			calls += 1;
			return Promise.resolve(fakeModelResponse(FAKE_REPLY));
		},
	});

	assert.equal(calls, 1);
	assert.equal(metadata.rawReplyLength, 17);
	assert.equal(metadata.rawReplyHash, hashText(FAKE_REPLY));
	assert.equal(metadata.finishReason, "STOP");
	assert.equal(metadata.commercialAccessLevel, 1);
	assert.equal(metadata.requestedNextAction, "continue_qualification");
	assert.deepEqual(metadata.rewrites, []);
	trap.mock.restore();
});

test("o curto-circuito de nível 3 é registrado como L0", async () => {
	const trap = trapRealClient();
	let calls = 0;
	const { metadata } = await generateMarianaReply({
		...buildParams("qual o valor da carta de 300 mil?"),
		generateContentFn: () => {
			calls += 1;
			return Promise.resolve(fakeModelResponse(FAKE_REPLY));
		},
	});

	assert.equal(calls, 0, "o modelo não pode ser chamado no curto-circuito");
	assert.equal(metadata.commercialAccessLevel, 3);
	assert.equal(metadata.rewrites?.[0].layer, "L0_level3_short_circuit");
	assert.equal(metadata.rewrites?.[0].lengthBefore, 0);
	assert.equal(metadata.rewrites?.[0].hashBefore, hashText(""));
	assert.equal(metadata.rawReplyLength, 0);
	trap.mock.restore();
});

test("sem generateContentFn a chamada vai para o cliente Gemini real", async () => {
	const call = mock.method(ai.models, "generateContent", () =>
		Promise.resolve(fakeModelResponse(FAKE_REPLY))
	);

	try {
		await generateMarianaReply(buildParams("como funciona o consórcio?"));

		assert.equal(call.mock.callCount(), 1);
	} finally {
		call.mock.restore();
	}
});

test("o erro de guardrail diz qual camada lançou", async () => {
	const trap = trapRealClient();

	try {
		// L4: menção de empresa não autorizada passa pelo saneador e trava na
		// asserção de segurança.
		await assert.rejects(
			() =>
				generateMarianaReply({
					...buildParams("como funciona o consórcio?"),
					generateContentFn: () =>
						Promise.resolve(
							fakeModelResponse("Somos a Ademicon. Seja bem-vindo à Ademicon.")
						),
				}),
			(error: unknown) => {
				assert.equal(
					(error as Error & TurnRewritesCarrier).turnGuardrailLayer,
					"L4_safety_assertion"
				);
				return true;
			}
		);

		// L2: id de evidência inventado.
		await assert.rejects(
			() =>
				generateMarianaReply({
					...buildParams("como funciona o consórcio?"),
					generateContentFn: () =>
						Promise.resolve(
							fakeModelResponse("O consórcio funciona por grupos.", [
								"id-que-nao-existe",
							])
						),
				}),
			(error: unknown) => {
				assert.equal(
					(error as Error & TurnRewritesCarrier).turnGuardrailLayer,
					"L2_evidence_invalid_id"
				);
				return true;
			}
		);
	} finally {
		trap.mock.restore();
	}
});
