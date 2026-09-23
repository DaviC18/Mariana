/** biome-ignore-all lint/suspicious/useAwait: <> */
/** biome-ignore-all lint/performance/useTopLevelRegex: <> */
/** biome-ignore-all lint/suspicious/noShadow: <> */
import assert from "node:assert/strict";
import test from "node:test";

import { eq } from "drizzle-orm";

import type { GenerateMarianaReplyResult, MarianaLead } from "../../ai/agent";
import { db } from "../../db/connections";
import { conversations, leads, messages } from "../../db/schema";
import type { ConsultantAvailableSlot } from "../../services/calendar/consultant-availability";
import { SchedulingAvailabilityService } from "../../services/calendar/scheduling-availability";
import { generateMarianaResponse } from "../../services/conversations/generateMarianaResponse";

function buildQualifiedLeadValues(phone: string) {
	return {
		birthDate: new Date("1995-01-01"),
		consortiumType: "imóvel",
		currentSituation: "Ainda não tenho imóvel",
		interestedInConsultant: true,
		name: "Lead Teste Etapa 9",
		objective: "Comprar um imóvel",
		painPoint: "Preciso encontrar uma forma planejada de compra",
		phone,
		qualifiedAt: new Date(),
		status: "qualified" as const,
	};
}

function buildAiResponse(lead: MarianaLead): GenerateMarianaReplyResult {
	return {
		metadata: {
			latencyMs: 1,
			model: "test-model",
			usage: null,
		},
		result: {
			leadUpdate: {
				status: lead.status as "qualified",
			},
			nextAction: "offer_meeting",
			reply: "Claro! Vou verificar os horários disponíveis para você.",
		},
	};
}

function buildSlot(
	consultantId: string,
	consultantName: string,
	start: string
): ConsultantAvailableSlot {
	const startDate = new Date(start);
	const endDate = new Date(startDate);
	endDate.setMinutes(endDate.getMinutes() + 30);

	return {
		consultant: {
			calendarId: `calendar-${consultantId}`,
			id: consultantId,
			name: consultantName,
		},
		end: endDate,
		start: startDate,
	};
}

test("Etapa 9 — oferece no máximo 3 slots reais e persiste a mesma mensagem final", async () => {
	const testPhone = `551199${Date.now().toString().slice(-8)}`;

	const [lead] = await db
		.insert(leads)
		.values(buildQualifiedLeadValues(testPhone))
		.returning({ id: leads.id });

	assert.ok(lead);

	const [conversation] = await db
		.insert(conversations)
		.values({
			leadId: lead.id,
		})
		.returning({ id: conversations.id });

	assert.ok(conversation);

	const slots = [
		buildSlot("consultant-1", "João Silva", "2026-09-23T15:00:00.000Z"),
		buildSlot("consultant-2", "Maria Souza", "2026-09-23T16:00:00.000Z"),
		buildSlot("consultant-3", "Carlos Oliveira", "2026-09-24T15:00:00.000Z"),
		buildSlot("consultant-4", "Consultor Extra", "2026-09-24T16:00:00.000Z"),
	];

	const schedulingAvailabilityService = new SchedulingAvailabilityService();

	let receivedTimeMin: Date | undefined;
	let receivedTimeMax: Date | undefined;
	let availabilityCalls = 0;

	schedulingAvailabilityService.getAvailableSlots = async (input) => {
		availabilityCalls += 1;
		receivedTimeMin = input.timeMin;
		receivedTimeMax = input.timeMax;
		return slots;
	};

	const nowBefore = Date.now();

	const result = await generateMarianaResponse({
		currentMessages: [
			"Olá, quais horários para reunião vocês têm disponíveis?",
		],
		generateMarianaReplyFn: async ({ lead }) => buildAiResponse(lead),
		leadId: lead.id,
		schedulingAvailabilityService,
	});

	const nowAfter = Date.now();

	assert.equal(availabilityCalls, 1);
	assert.ok(receivedTimeMin);
	assert.ok(receivedTimeMax);

	assert.ok(receivedTimeMin.getTime() >= nowBefore);
	assert.ok(receivedTimeMin.getTime() <= nowAfter);

	assert.equal(
		receivedTimeMax.getTime() - receivedTimeMin.getTime(),
		5 * 24 * 60 * 60 * 1000
	);

	assert.match(result.result.reply, /Tenho estes horários disponíveis:/);
	assert.match(result.result.reply, /1\./);
	assert.match(result.result.reply, /2\./);
	assert.match(result.result.reply, /3\./);

	assert.doesNotMatch(result.result.reply, /Consultor Extra/);

	const [assistantMessage] = await db
		.select()
		.from(messages)
		.where(eq(messages.id, result.assistantMessage?.id ?? ""));

	assert.ok(assistantMessage);
	assert.equal(assistantMessage.content, result.result.reply);

	await db.delete(messages).where(eq(messages.conversationId, conversation.id));
	await db.delete(conversations).where(eq(conversations.id, conversation.id));
	await db.delete(leads).where(eq(leads.id, lead.id));
});

test("Etapa 9 — não consulta disponibilidade quando a ação não é offer_meeting", async () => {
	const testPhone = `551198${Date.now().toString().slice(-8)}`;

	const [lead] = await db
		.insert(leads)
		.values(buildQualifiedLeadValues(testPhone))
		.returning({ id: leads.id });

	assert.ok(lead);

	const [conversation] = await db
		.insert(conversations)
		.values({
			leadId: lead.id,
		})
		.returning({ id: conversations.id });

	assert.ok(conversation);

	const schedulingAvailabilityService = new SchedulingAvailabilityService();

	let availabilityCalls = 0;

	schedulingAvailabilityService.getAvailableSlots = async () => {
		availabilityCalls += 1;
		return [];
	};

	const result = await generateMarianaResponse({
		currentMessages: ["Quero entender melhor como funciona o consórcio."],
		generateMarianaReplyFn: async () => ({
			metadata: {
				latencyMs: 1,
				model: "test-model",
				usage: null,
			},
			result: {
				leadUpdate: {
					status: "qualified",
				},
				nextAction: "continue_qualification",
				reply: "Claro! Posso explicar como funciona.",
			},
		}),
		leadId: lead.id,
		schedulingAvailabilityService,
	});

	assert.equal(availabilityCalls, 0);
	assert.equal(result.result.reply, "Claro! Posso explicar como funciona.");

	await db.delete(messages).where(eq(messages.conversationId, conversation.id));
	await db.delete(conversations).where(eq(conversations.id, conversation.id));
	await db.delete(leads).where(eq(leads.id, lead.id));
});
