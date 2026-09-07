import assert from "node:assert/strict";
import test from "node:test";

import { marianaResponseSchema } from "./schemas/mariana-response-schema";

test("CASO 1 — resposta válida", () => {
	const payload = {
		leadUpdate: {
			consortiumType: "Imóvel",
			objective: "Comprar um imóvel",
			status: "qualifying",
		},
		nextAction: "continue_qualification",
		reply: "Posso te orientar sobre consórcio de imóvel.",
	};

	assert.doesNotThrow(() => marianaResponseSchema.parse(payload));
});

test("CASO 2 — status inválido", () => {
	const payload = {
		leadUpdate: {
			consortiumType: "Imóvel",
			objective: "Comprar um imóvel",
			status: "banana",
		},
		nextAction: "continue_qualification",
		reply: "Mensagem válida",
	};

	assert.throws(() => marianaResponseSchema.parse(payload));
});

test("CASO 3 — nextAction inválida", () => {
	const payload = {
		leadUpdate: {
			consortiumType: null,
			objective: null,
			status: "new",
		},
		nextAction: "do_everything",
		reply: "Mensagem válida",
	};

	assert.throws(() => marianaResponseSchema.parse(payload));
});

test("CASO 4 — reply vazia", () => {
	const payload = {
		leadUpdate: {
			consortiumType: null,
			objective: null,
			status: "new",
		},
		nextAction: "continue_qualification",
		reply: "",
	};

	assert.throws(() => marianaResponseSchema.parse(payload));
});
