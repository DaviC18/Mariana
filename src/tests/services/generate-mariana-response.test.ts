/** biome-ignore-all lint/suspicious/useAwait: <> */
/** biome-ignore-all lint/performance/useTopLevelRegex: <> */
/** biome-ignore-all lint/suspicious/noShadow: <> */
import assert from "node:assert/strict";
import test from "node:test";

import { eq } from "drizzle-orm";

import type { GenerateMarianaReplyResult, MarianaLead } from "../../ai/agent";
import { db } from "../../db/connections";
import {
	consultants,
	conversations,
	leads,
	messages,
	schedulingSessions,
	schedulingSlots,
} from "../../db/schema";
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

	const dbConsultants = await db
		.select({
			calendarId: consultants.calendarId,
			id: consultants.id,
			name: consultants.name,
		})
		.from(consultants)
		.where(eq(consultants.active, true))
		.limit(3);

	assert.ok(
		dbConsultants.length >= 3,
		"Pelo menos 3 consultores devem existir no banco"
	);

	const slots = [
		buildSlot(
			dbConsultants[0].id,
			dbConsultants[0].name,
			"2026-09-23T15:00:00.000Z"
		),
		buildSlot(
			dbConsultants[1].id,
			dbConsultants[1].name,
			"2026-09-23T16:00:00.000Z"
		),
		buildSlot(
			dbConsultants[2].id,
			dbConsultants[2].name,
			"2026-09-24T15:00:00.000Z"
		),
		buildSlot(
			dbConsultants[0].id,
			"Consultor Extra",
			"2026-09-24T16:00:00.000Z"
		),
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
	await db
		.delete(schedulingSessions)
		.where(eq(schedulingSessions.leadId, lead.id));
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
	assert.equal(
		result.schedulingOffer,
		undefined,
		"Não deve existir oferta estruturada quando a ação não é offer_meeting"
	);

	await db.delete(messages).where(eq(messages.conversationId, conversation.id));
	await db.delete(conversations).where(eq(conversations.id, conversation.id));
	await db.delete(leads).where(eq(leads.id, lead.id));
});

test("Etapa 10 — TESTES 1, 2, 3 e 10: persistência de exatamente 3 slots, dados idênticos, sessão active com TTL 15min e mensagem idêntica", async () => {
	const testPhone = `551197${Date.now().toString().slice(-8)}`;

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

	const dbConsultants = await db
		.select({
			calendarId: consultants.calendarId,
			id: consultants.id,
			name: consultants.name,
		})
		.from(consultants)
		.where(eq(consultants.active, true))
		.limit(3);

	assert.ok(dbConsultants.length >= 3);

	const slot1Start = "2026-09-25T14:00:00.000Z";
	const slot2Start = "2026-09-25T15:00:00.000Z";
	const slot3Start = "2026-09-25T16:00:00.000Z";
	const slot4Start = "2026-09-25T17:00:00.000Z";

	const slots = [
		buildSlot(dbConsultants[0].id, dbConsultants[0].name, slot1Start),
		buildSlot(dbConsultants[1].id, dbConsultants[1].name, slot2Start),
		buildSlot(dbConsultants[2].id, dbConsultants[2].name, slot3Start),
		buildSlot(dbConsultants[0].id, "Consultor Excedente", slot4Start),
	];

	const schedulingAvailabilityService = new SchedulingAvailabilityService();
	schedulingAvailabilityService.getAvailableSlots = async () => slots;

	const result = await generateMarianaResponse({
		currentMessages: ["Quais horários vocês têm para agendar uma reunião?"],
		generateMarianaReplyFn: async ({ lead: l }) => buildAiResponse(l),
		leadId: lead.id,
		schedulingAvailabilityService,
	});

	// TESTE 10: Mensagem retornada é idêntica à persistida e gerada pelos offeredSlots
	assert.ok(result.assistantMessage);

	const [persistedAssistantMessage] = await db
		.select()
		.from(messages)
		.where(eq(messages.id, result.assistantMessage.id));

	assert.ok(persistedAssistantMessage);
	assert.equal(persistedAssistantMessage.content, result.result.reply);
	assert.equal(result.assistantMessage.content, result.result.reply);

	// TESTE 3: Verificar SchedulingSession
	const [session] = await db
		.select()
		.from(schedulingSessions)
		.where(eq(schedulingSessions.leadId, lead.id))
		.limit(1);

	assert.ok(session, "SchedulingSession deve ter sido criada");

	assert.ok(
		result.schedulingOffer,
		"A oferta estruturada deve existir quando há horários disponíveis"
	);

	assert.equal(
		result.schedulingOffer.session.id,
		session.id,
		"A sessão retornada deve ser a mesma sessão persistida"
	);

	assert.equal(session.status, "active");
	assert.equal(session.leadId, lead.id);
	assert.equal(session.conversationId, conversation.id);

	// Expiração aproximada de 15 minutos: expiresAt = createdAt + 15 min
	const sessionCreatedTime = session.createdAt.getTime();
	const sessionExpiresTime = session.expiresAt.getTime();
	const diffMinutes = (sessionExpiresTime - sessionCreatedTime) / (60 * 1000);

	assert.ok(
		Math.abs(diffMinutes - 15) < 0.1,
		`expiresAt deve ser +15 minutos do createdAt, mas foi ${diffMinutes} min`
	);

	// TESTE 1: Verificar que apenas 3 slots são persistidos com positions 1, 2, 3
	const persistedSlots = await db
		.select()
		.from(schedulingSlots)
		.where(eq(schedulingSlots.schedulingSessionId, session.id))
		.orderBy(schedulingSlots.position);

	assert.equal(
		persistedSlots.length,
		3,
		"Apenas 3 slots devem ser persistidos"
	);

	assert.equal(
		result.schedulingOffer.slots.length,
		3,
		"A oferta estruturada deve conter exatamente 3 slots"
	);

	assert.deepEqual(
		result.schedulingOffer.slots.map((slot) => slot.id),
		persistedSlots.map((slot) => slot.id),
		"Os slots retornados devem ser exatamente os slots persistidos"
	);

	assert.deepEqual(
		persistedSlots.map((s) => s.position),
		[1, 2, 3],
		"Positions devem ser 1, 2, 3"
	);

	// TESTE 2: Dados persistidos correspondem exatamente ao offeredSlots
	const offeredSlots = slots.slice(0, 3);

	for (let i = 0; i < 3; i += 1) {
		const expectedSlot = offeredSlots[i];
		const actualSlot = persistedSlots[i];

		assert.equal(actualSlot.consultantId, expectedSlot.consultant.id);
		assert.equal(actualSlot.consultantName, expectedSlot.consultant.name);
		assert.equal(actualSlot.calendarId, expectedSlot.consultant.calendarId);

		assert.equal(
			actualSlot.startAt.toISOString(),
			expectedSlot.start.toISOString()
		);

		assert.equal(
			actualSlot.endAt.toISOString(),
			expectedSlot.end.toISOString()
		);
	}

	// Cleanup
	await db.delete(messages).where(eq(messages.conversationId, conversation.id));

	await db
		.delete(schedulingSessions)
		.where(eq(schedulingSessions.id, session.id));

	await db.delete(conversations).where(eq(conversations.id, conversation.id));
	await db.delete(leads).where(eq(leads.id, lead.id));
});

test("Etapa 10 — TESTE 4: sem disponibilidade (offeredSlots = []) não cria session nem slots", async () => {
	const testPhone = `551196${Date.now().toString().slice(-8)}`;

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
	schedulingAvailabilityService.getAvailableSlots = async () => [];

	const result = await generateMarianaResponse({
		currentMessages: ["Tem algum horário disponível?"],
		generateMarianaReplyFn: async ({ lead: l }) => buildAiResponse(l),
		leadId: lead.id,
		schedulingAvailabilityService,
	});

	assert.equal(
		result.schedulingOffer,
		undefined,
		"Não deve existir oferta estruturada quando não há disponibilidade"
	);

	assert.match(
		result.result.reply,
		/No momento, não encontrei horários disponíveis nos próximos 5 dias\./
	);

	const sessions = await db
		.select()
		.from(schedulingSessions)
		.where(eq(schedulingSessions.leadId, lead.id));

	assert.equal(
		sessions.length,
		0,
		"Nenhuma scheduling_session deve ser criada"
	);

	// Cleanup
	await db.delete(messages).where(eq(messages.conversationId, conversation.id));
	await db.delete(conversations).where(eq(conversations.id, conversation.id));
	await db.delete(leads).where(eq(leads.id, lead.id));
});

test("Etapa 10 — TESTE 5: nova oferta para lead que já possui session active fecha anterior e mantém apenas 1 active", async () => {
	const testPhone = `551195${Date.now().toString().slice(-8)}`;

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

	const dbConsultants = await db
		.select({
			calendarId: consultants.calendarId,
			id: consultants.id,
			name: consultants.name,
		})
		.from(consultants)
		.where(eq(consultants.active, true))
		.limit(3);

	assert.ok(dbConsultants.length >= 3);

	const slotsOffer1 = [
		buildSlot(
			dbConsultants[0].id,
			dbConsultants[0].name,
			"2026-09-25T14:00:00.000Z"
		),
	];

	const slotsOffer2 = [
		buildSlot(
			dbConsultants[1].id,
			dbConsultants[1].name,
			"2026-09-26T14:00:00.000Z"
		),
	];

	const schedulingAvailabilityService = new SchedulingAvailabilityService();

	// Primeira oferta
	schedulingAvailabilityService.getAvailableSlots = async () => slotsOffer1;

	await generateMarianaResponse({
		currentMessages: ["Quero ver horários."],
		generateMarianaReplyFn: async ({ lead: l }) => buildAiResponse(l),
		leadId: lead.id,
		schedulingAvailabilityService,
	});

	const [firstSession] = await db
		.select()
		.from(schedulingSessions)
		.where(eq(schedulingSessions.leadId, lead.id));

	assert.ok(firstSession);
	assert.equal(firstSession.status, "active");

	// Segunda oferta para o mesmo lead
	schedulingAvailabilityService.getAvailableSlots = async () => slotsOffer2;

	await generateMarianaResponse({
		currentMessages: ["Pode me mandar outros horários?"],
		generateMarianaReplyFn: async ({ lead: l }) => buildAiResponse(l),
		leadId: lead.id,
		schedulingAvailabilityService,
	});

	const allSessions = await db
		.select()
		.from(schedulingSessions)
		.where(eq(schedulingSessions.leadId, lead.id))
		.orderBy(schedulingSessions.createdAt);

	assert.equal(allSessions.length, 2, "Devem existir duas sessões");
	assert.equal(allSessions[0].id, firstSession.id);

	assert.equal(
		allSessions[0].status,
		"closed",
		"Primeira sessão deve ter sido alterada para closed"
	);

	assert.equal(
		allSessions[1].status,
		"active",
		"Nova sessão deve estar active"
	);

	const activeSessions = allSessions.filter((s) => s.status === "active");

	assert.equal(
		activeSessions.length,
		1,
		"Exatamente uma sessão deve estar active"
	);

	// Cleanup
	await db.delete(messages).where(eq(messages.conversationId, conversation.id));

	await db
		.delete(schedulingSessions)
		.where(eq(schedulingSessions.leadId, lead.id));

	await db.delete(conversations).where(eq(conversations.id, conversation.id));
	await db.delete(leads).where(eq(leads.id, lead.id));
});

test("Etapa 10 — TESTE 6: ação diferente de offer_meeting (continue_qualification) não consulta nem cria session/slots", async () => {
	const testPhone = `551194${Date.now().toString().slice(-8)}`;

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

	let availabilityCalled = false;

	schedulingAvailabilityService.getAvailableSlots = async () => {
		availabilityCalled = true;
		return [];
	};

	const result = await generateMarianaResponse({
		currentMessages: ["Ainda tenho dúvidas sobre parcelas."],
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
				reply: "Posso tirar suas dúvidas sobre as parcelas.",
			},
		}),
		leadId: lead.id,
		schedulingAvailabilityService,
	});

	assert.equal(
		availabilityCalled,
		false,
		"SchedulingAvailabilityService não deve ser chamado"
	);

	assert.equal(
		result.schedulingOffer,
		undefined,
		"Não deve existir oferta estruturada para continue_qualification"
	);

	const sessions = await db
		.select()
		.from(schedulingSessions)
		.where(eq(schedulingSessions.leadId, lead.id));

	assert.equal(
		sessions.length,
		0,
		"Nenhuma scheduling_session deve ser criada"
	);

	// Cleanup
	await db.delete(messages).where(eq(messages.conversationId, conversation.id));
	await db.delete(conversations).where(eq(conversations.id, conversation.id));
	await db.delete(leads).where(eq(leads.id, lead.id));
});

test("Etapa 10 — oferta estruturada com exatamente 1 slot", async () => {
	const testPhone = `551193${Date.now().toString().slice(-8)}`;

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

	const offeredSlot = buildSlot(
		consultant.id,
		consultant.name,
		"2026-09-25T14:00:00.000Z"
	);

	const schedulingAvailabilityService = new SchedulingAvailabilityService();

	schedulingAvailabilityService.getAvailableSlots = async () => [offeredSlot];

	const result = await generateMarianaResponse({
		currentMessages: ["Pode me passar o horário disponível?"],
		generateMarianaReplyFn: async ({ lead: l }) => buildAiResponse(l),
		leadId: lead.id,
		schedulingAvailabilityService,
	});

	assert.ok(
		result.schedulingOffer,
		"A oferta estruturada deve existir quando há 1 horário disponível"
	);

	assert.equal(
		result.schedulingOffer.slots.length,
		1,
		"A oferta estruturada deve conter exatamente 1 slot"
	);

	const [persistedSession] = await db
		.select()
		.from(schedulingSessions)
		.where(eq(schedulingSessions.leadId, lead.id))
		.limit(1);

	assert.ok(persistedSession);

	const persistedSlots = await db
		.select()
		.from(schedulingSlots)
		.where(eq(schedulingSlots.schedulingSessionId, persistedSession.id))
		.orderBy(schedulingSlots.position);

	assert.equal(
		persistedSlots.length,
		1,
		"Exatamente 1 slot deve ser persistido"
	);

	assert.equal(
		result.schedulingOffer.session.id,
		persistedSession.id,
		"A sessão retornada deve ser a sessão persistida"
	);

	assert.equal(
		result.schedulingOffer.slots[0].id,
		persistedSlots[0].id,
		"O slot retornado deve ser o mesmo slot persistido"
	);

	assert.equal(
		result.schedulingOffer.slots[0].consultantId,
		offeredSlot.consultant.id
	);

	assert.equal(
		result.schedulingOffer.slots[0].consultantName,
		offeredSlot.consultant.name
	);

	assert.equal(
		result.schedulingOffer.slots[0].calendarId,
		offeredSlot.consultant.calendarId
	);

	assert.equal(
		result.schedulingOffer.slots[0].startAt.toISOString(),
		offeredSlot.start.toISOString()
	);

	assert.equal(
		result.schedulingOffer.slots[0].endAt.toISOString(),
		offeredSlot.end.toISOString()
	);

	assert.match(result.result.reply, /Tenho estes horários disponíveis:/);

	assert.match(result.result.reply, /1\./);

	assert.doesNotMatch(result.result.reply, /2\./);
	assert.doesNotMatch(result.result.reply, /3\./);

	await db.delete(messages).where(eq(messages.conversationId, conversation.id));

	await db
		.delete(schedulingSessions)
		.where(eq(schedulingSessions.leadId, lead.id));

	await db.delete(conversations).where(eq(conversations.id, conversation.id));
	await db.delete(leads).where(eq(leads.id, lead.id));
});
