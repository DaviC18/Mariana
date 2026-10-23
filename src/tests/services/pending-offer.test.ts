import assert from "node:assert/strict";
import test from "node:test";

import {
	COMMERCIAL_HANDOFF,
	CONSULTANT_OFFER_TEXT,
} from "../../ai/knowledge/commercial-policy";
import {
	acceptsPendingOffer,
	detectPendingOffer,
	isClearAffirmative,
} from "../../services/conversations/pending-offer";
import { CONSULTANT_REASON_QUESTION } from "../../services/leads/qualification-gaps";

const AFFIRMATIVES = [
	"sim",
	"Sim!",
	"sim porfavor",
	"sim por favor",
	"sim eu quero",
	"quero",
	"quero sim",
	"pode ser",
	"claro",
	"ok",
	"Ok, pode",
	"aceito",
	"pode",
	"isso",
	"com certeza",
	"bora",
	"s",
];

const NOT_AFFIRMATIVES = [
	"não",
	"nao",
	"não, agora não",
	"agora não",
	"depois",
	"sim, mas depois",
	"talvez",
	"não sei",
	"quanto custa?",
	"sim? como assim",
	"prefiro não",
	"",
];

test("afirmativas claras em pt-BR são reconhecidas", () => {
	for (const message of AFFIRMATIVES) {
		assert.equal(isClearAffirmative(message), true, message);
	}
});

test("negações, adiamentos e mensagens ambíguas não são afirmativas", () => {
	for (const message of NOT_AFFIRMATIVES) {
		assert.equal(isClearAffirmative(message), false, message);
	}
});

test("afirmativa sem oferta pendente não aceita nada", () => {
	assert.equal(
		acceptsPendingOffer({
			currentMessages: ["sim eu quero"],
			pendingOffer: null,
		}),
		false
	);
});

test("oferta pendente + afirmativa aceita a oferta", () => {
	assert.equal(
		acceptsPendingOffer({
			currentMessages: ["sim eu quero"],
			pendingOffer: "consultant_meeting",
		}),
		true
	);
});

test("oferta pendente + negação não aceita a oferta", () => {
	assert.equal(
		acceptsPendingOffer({
			currentMessages: ["não, agora não"],
			pendingOffer: "consultant_meeting",
		}),
		false
	);
});

test("bloco com afirmativa e negação não aceita a oferta", () => {
	assert.equal(
		acceptsPendingOffer({
			currentMessages: ["sim", "na verdade agora não"],
			pendingOffer: "consultant_meeting",
		}),
		false
	);
});

test("marcador vem do texto exato do backend na última mensagem da assistente", () => {
	assert.equal(
		detectPendingOffer(`Entendi! ${CONSULTANT_OFFER_TEXT}`),
		"consultant_meeting"
	);
	assert.equal(detectPendingOffer(COMMERCIAL_HANDOFF), "consultant_meeting");
	assert.equal(
		detectPendingOffer(`Claro! ${CONSULTANT_REASON_QUESTION}`),
		"consultant_reason"
	);
	assert.equal(
		detectPendingOffer(
			"Você gostaria de conversar com um consultor especializado?"
		),
		null
	);
	assert.equal(detectPendingOffer(undefined), null);
});
