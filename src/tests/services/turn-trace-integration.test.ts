/** biome-ignore-all lint/suspicious/useAwait: <> */
// Testes adversariais do tester para o Batch C de `2026-10-22-pkg-A`.
// Suíte de banco. O cliente Gemini real nunca é chamado: o agente recebe
// sempre um `generateContentFn` falso.
import assert from "node:assert/strict";
import test from "node:test";
import type { GenerateContentResponse } from "@google/genai";
import { eq } from "drizzle-orm";

import {
	type GenerateMarianaReplyResult,
	generateMarianaReply,
	type MarianaLead,
	type TurnRewritesCarrier,
} from "../../ai/agent";
import { closeDatabase, db } from "../../db/connections";
import { consultants, conversations, leads } from "../../db/schema";
import { hashText } from "../../lib/turn-trace";
import type { ConsultantAvailableSlot } from "../../services/calendar/consultant-availability";
import { SchedulingAvailabilityService } from "../../services/calendar/scheduling-availability";
import { generateMarianaResponse } from "../../services/conversations/generateMarianaResponse";

const MARIANA_TURN_EVENT = '"event":"mariana_turn"';
const ELEVEN_DIGITS = /\d{11}/;
const GUARDRAIL_MESSAGE = /guardrails/;
const UNAVAILABLE_EVIDENCE = /unavailable knowledge evidence/;

test.after(async () => {
	await closeDatabase();
});

function captureTurnTraceLines() {
	const lines: string[] = [];
	const original = console.info;

	console.info = (...args: unknown[]) => {
		if (typeof args[0] === "string" && args[0].includes(MARIANA_TURN_EVENT)) {
			lines.push(args[0]);
			return;
		}

		original(...(args as []));
	};

	return {
		lines,
		restore: () => {
			console.info = original;
		},
	};
}

function qualifiedLeadValues(phone: string) {
	return {
		birthDate: new Date("1995-01-01"),
		consortiumType: "imóvel",
		currentSituation: "Ainda não tenho imóvel",
		interestedInConsultant: true,
		name: "Lead Rastro Tester",
		objective: "Comprar um imóvel",
		painPoint: "Preciso de uma compra planejada",
		phone,
		qualifiedAt: new Date(),
		status: "qualified" as const,
	};
}

async function seedLead(tag: string) {
	const phone = `551197${Date.now().toString().slice(-8)}`;
	const [lead] = await db
		.insert(leads)
		.values({ ...qualifiedLeadValues(phone), name: `Rastro ${tag}` })
		.returning({ id: leads.id });

	assert.ok(lead);

	const [conversation] = await db
		.insert(conversations)
		.values({ leadId: lead.id })
		.returning({ id: conversations.id });

	assert.ok(conversation);

	return { conversationId: conversation.id, leadId: lead.id, phone };
}

function modelResponse(reply: string, evidenceUsed: string[] = []) {
	return {
		candidates: [{ finishReason: "STOP" }],
		modelVersion: "gemini-3.5-flash-lite-001",
		text: JSON.stringify({
			businessAction: "answer_basic_question",
			evidenceUsed,
			leadUpdate: { status: "qualified" },
			nextAction: "continue_qualification",
			reply,
		}),
		usageMetadata: {},
	} as unknown as GenerateContentResponse;
}

// Faz o turno passar pelo agente de verdade (L0–L4 reais), com o modelo falso.
function realAgentWith(reply: string, evidenceUsed: string[] = []) {
	return (params: Parameters<typeof generateMarianaReply>[0]) =>
		generateMarianaReply({
			...params,
			generateContentFn: () =>
				Promise.resolve(modelResponse(reply, evidenceUsed)),
		});
}

function slotFor(
	consultantId: string,
	consultantName: string
): ConsultantAvailableSlot {
	const start = new Date("2026-09-25T14:00:00.000Z");
	const end = new Date(start);
	end.setMinutes(end.getMinutes() + 30);

	return {
		consultant: {
			calendarId: `calendar-${consultantId}`,
			id: consultantId,
			name: consultantName,
		},
		end,
		start,
	};
}

test("um guardrail real de identidade (L4) vira uma linha com a camada que lançou", async () => {
	const { leadId } = await seedLead("L4");
	const capture = captureTurnTraceLines();
	let caught: unknown;

	try {
		await assert.rejects(
			() =>
				generateMarianaResponse({
					currentMessages: ["como funciona o consórcio?"],
					generateMarianaReplyFn: realAgentWith(
						"Somos a Ademicon. Seja bem-vindo à Ademicon."
					),
					leadId,
					traceTurnId: "b1f7a3c5-6d28-4e91-8a4f-5c2e7d9b1a63",
				}),
			(error: unknown) => {
				caught = error;
				return GUARDRAIL_MESSAGE.test((error as Error).message);
			}
		);
	} finally {
		capture.restore();
	}

	// O erro é repassado sem alteração: mesmo tipo, mesma mensagem, e ainda
	// com os registros parciais que o agente anexou.
	const carrier = caught as Error & TurnRewritesCarrier;

	assert.ok(carrier instanceof Error);
	assert.equal(carrier.turnGuardrailLayer, "L4_safety_assertion");
	assert.deepEqual(
		carrier.turnRewrites?.map((record) => record.layer),
		["L1_identity_sanitizer"]
	);

	assert.equal(capture.lines.length, 1);

	const trace = JSON.parse(capture.lines[0]);

	assert.equal(trace.outcome, "guardrail_throw");
	assert.equal(trace.guardrailLayer, "L4_safety_assertion");
	assert.equal(trace.sentReplyHash, null);
	assert.equal(trace.sentReplyLength, null);
	assert.equal(trace.rewritesReported, true);
	assert.deepEqual(
		trace.rewrites.map((record: { layer: string }) => record.layer),
		["L1_identity_sanitizer"]
	);
	assert.equal(trace.pureBackendText, null);
});

test("um guardrail real de evidência (L2) é distinguível de L4 na linha", async () => {
	const { leadId } = await seedLead("L2");
	const capture = captureTurnTraceLines();

	try {
		await assert.rejects(
			() =>
				generateMarianaResponse({
					currentMessages: ["como funciona o consórcio?"],
					generateMarianaReplyFn: realAgentWith(
						"O consórcio funciona por grupos.",
						["evidencia-que-nao-existe"]
					),
					leadId,
					traceTurnId: "d4c9b2e7-1a53-4f86-9b20-7e5a3c1d8f42",
				}),
			UNAVAILABLE_EVIDENCE
		);
	} finally {
		capture.restore();
	}

	assert.equal(capture.lines.length, 1);

	const trace = JSON.parse(capture.lines[0]);

	assert.equal(trace.guardrailLayer, "L2_evidence_invalid_id");
	assert.notEqual(trace.guardrailLayer, "L4_safety_assertion");
	assert.equal(trace.outcome, "guardrail_throw");
});

test("L11 é registrada e encadeada quando a oferta de horários troca o texto", async () => {
	const { leadId, phone } = await seedLead("L11");
	const [consultant] = await db
		.select({
			calendarId: consultants.calendarId,
			id: consultants.id,
			name: consultants.name,
		})
		.from(consultants)
		.where(eq(consultants.active, true))
		.limit(1);

	assert.ok(consultant);

	const availability = new SchedulingAvailabilityService();

	availability.getAvailableSlots = async () => [
		slotFor(consultant.id, consultant.name),
	];

	const modelReply = "Claro! Vou verificar os horários disponíveis para você.";
	const capture = captureTurnTraceLines();
	let result: Awaited<ReturnType<typeof generateMarianaResponse>>;

	try {
		result = await generateMarianaResponse({
			currentMessages: ["Pode me passar o horário disponível?"],
			generateMarianaReplyFn: async ({
				lead,
			}): Promise<GenerateMarianaReplyResult> => ({
				metadata: {
					commercialAccessLevel: 1,
					finishReason: "STOP",
					latencyMs: 3,
					model: "test-model",
					rawReplyHash: hashText(modelReply),
					rawReplyLength: modelReply.length,
					requestedNextAction: "offer_meeting",
					rewrites: [],
					usage: null,
				},
				result: {
					leadUpdate: { status: (lead as MarianaLead).status as "qualified" },
					nextAction: "offer_meeting",
					reply: modelReply,
				},
			}),
			leadId,
			schedulingAvailabilityService: availability,
			traceTurnId: "f2a6d8b4-3c71-4e05-9d68-1b4f7a2e5c93",
		});
	} finally {
		capture.restore();
	}

	assert.ok(result.schedulingOffer);
	assert.equal(capture.lines.length, 1);

	const [line] = capture.lines;
	const trace = JSON.parse(line);
	const offer = trace.rewrites.find(
		(record: { layer: string }) => record.layer === "L11_slot_offer_replaced"
	);

	assert.ok(offer, line);
	assert.equal(offer.hashAfter, trace.sentReplyHash);
	assert.equal(offer.lengthAfter, trace.sentReplyLength);
	assert.equal(trace.rawReplyHash, hashText(modelReply));
	assert.equal(trace.outcome, "replied");
	assert.equal(trace.rewritesReported, true);

	// A oferta carrega data, hora e nome do consultor: nada disso na linha.
	assert.equal(line.includes(consultant.name), false);
	assert.equal(line.includes(phone), false);
	assert.equal(ELEVEN_DIGITS.test(line), false);
});

test("o rastro nunca repete nem omite a linha quando o texto é 100% do backend", async () => {
	const { leadId } = await seedLead("L5");
	const capture = captureTurnTraceLines();

	try {
		// Pergunta de nível 3: o agente real curto-circuita e devolve o repasse
		// comercial, sem chamar o modelo.
		await generateMarianaResponse({
			currentMessages: ["qual o valor da carta de 300 mil?"],
			generateMarianaReplyFn: realAgentWith("texto que não será usado"),
			leadId,
			traceTurnId: "a7e3f1c9-5b24-4d60-8f93-2c6b8d4a1e75",
		});
	} finally {
		capture.restore();
	}

	assert.equal(capture.lines.length, 1);

	const trace = JSON.parse(capture.lines[0]);
	const layers = trace.rewrites.map(
		(record: { layer: string }) => record.layer
	);

	assert.equal(trace.outcome, "replied");
	assert.ok(layers.includes("L0_level3_short_circuit"), capture.lines[0]);
	assert.equal(trace.rewritesReported, true);
	assert.equal(trace.commercialAccessLevel, 3);
	assert.equal(typeof trace.pureBackendText, "boolean");
});
