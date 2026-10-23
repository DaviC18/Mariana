import assert from "node:assert/strict";
import test from "node:test";

import { CONSULTANT_OFFER_TEXT } from "../ai/knowledge/commercial-policy";
import {
	CURRENT_SITUATION_QUESTION,
	REASON_QUESTION,
} from "../services/leads/qualification-gaps";
import {
	evaluateSimulatedConversation,
	type SimulatedTurn,
} from "./support/simulation-checks";

const KNOWN_NOTHING = {
	currentSituation: false,
	interestedInConsultant: false,
	name: true,
	objective: false,
	painPoint: false,
};

function turn(
	reply: string,
	overrides: Partial<SimulatedTurn> = {}
): SimulatedTurn {
	return {
		known: KNOWN_NOTHING,
		offered: false,
		reply,
		user: ["oi"],
		...overrides,
	};
}

test("conversa que chega aos horários dentro do limite passa", () => {
	const failures = evaluateSimulatedConversation({
		offerWithinTurns: 3,
		turns: [
			turn(`Olá! ${REASON_QUESTION}`),
			turn(`Entendi! ${CONSULTANT_OFFER_TEXT}`, {
				known: { ...KNOWN_NOTHING, objective: true },
			}),
			turn("Tenho estes horários disponíveis:\n\n1. 16/10/2026 às 10:00", {
				offered: true,
			}),
		],
	});
	assert.deepEqual(failures, []);
});

test("horários fora do limite falham", () => {
	const failures = evaluateSimulatedConversation({
		offerWithinTurns: 1,
		turns: [turn("Olá!"), turn("Ok.", { offered: true })],
	});
	assert.ok(failures.some((failure) => failure.includes("within 1")));
});

test("pergunta repetida falha", () => {
	const failures = evaluateSimulatedConversation({
		offerWithinTurns: 5,
		turns: [
			turn(REASON_QUESTION),
			turn(REASON_QUESTION),
			turn("", { offered: true }),
		],
	});
	assert.ok(failures.some((failure) => failure.includes("repeated question")));
});

test("pergunta sobre campo já respondido falha", () => {
	const failures = evaluateSimulatedConversation({
		offerWithinTurns: 5,
		turns: [
			turn(CURRENT_SITUATION_QUESTION, {
				known: { ...KNOWN_NOTHING, currentSituation: true },
			}),
			turn("", { offered: true }),
		],
	});
	assert.ok(failures.some((failure) => failure.includes("re-asked")));
});

test("números que o cliente não informou falham; os dele são permitidos", () => {
	const invented = evaluateSimulatedConversation({
		offerWithinTurns: 5,
		turns: [turn("A parcela fica em R$ 500."), turn("", { offered: true })],
	});
	assert.ok(invented.some((failure) => failure.includes("number")));

	const stated = evaluateSimulatedConversation({
		offerWithinTurns: 5,
		turns: [
			turn("Anotado, crédito de R$ 100 mil.", {
				user: ["quero um crédito de R$ 100 mil"],
			}),
			turn("", { offered: true }),
		],
	});
	assert.deepEqual(stated, []);
});

test("mais de 3 frases ou mais de uma pergunta falham", () => {
	const failures = evaluateSimulatedConversation({
		offerWithinTurns: 5,
		turns: [
			turn("Um. Dois. Três. Quatro."),
			turn("Pode? E agora?"),
			turn("", { offered: true }),
		],
	});
	assert.ok(failures.some((failure) => failure.includes("sentences")));
	assert.ok(failures.some((failure) => failure.includes("questions")));
});
