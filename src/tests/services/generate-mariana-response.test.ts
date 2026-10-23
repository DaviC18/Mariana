/** biome-ignore-all lint/suspicious/useAwait: <> */
/** biome-ignore-all lint/performance/useTopLevelRegex: <> */
/** biome-ignore-all lint/suspicious/noShadow: <> */
import assert from "node:assert/strict";
import test from "node:test";

import { eq } from "drizzle-orm";

import type { GenerateMarianaReplyResult, MarianaLead } from "../../ai/agent";
import { ModelUnavailableError } from "../../ai/model-errors";
import { closeDatabase, db } from "../../db/connections";
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
import { SchedulingConfirmationService } from "../../services/calendar/scheduling-confirmation-service";
import { generateMarianaResponse } from "../../services/conversations/generateMarianaResponse";

test.after(async () => {
	await closeDatabase();
});

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
		persistedSession.selectedSlotId,
		null,
		"O slot não deve ser selecionado automaticamente"
	);

	assert.equal(
		persistedSession.workflowStage,
		"awaiting_availability",
		"A sessão deve aguardar o processamento da tarefa de preferência"
	);

	const confirmation =
		await new SchedulingConfirmationService().resolveConfirmation({
			buttonId: `confirm:${persistedSlots[0].id}`,
			conversationId: conversation.id,
			leadId: lead.id,
		});

	assert.equal(
		confirmation.ok,
		false,
		"Não deve aceitar confirmação antes da seleção do slot"
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

const MARIANA_TURN_EVENT = '"event":"mariana_turn"';
const ELEVEN_DIGITS_IN_LINE = /\d{11}/;

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

async function seedTraceLead(suffix: string) {
	const testPhone = `551198${Date.now().toString().slice(-7)}`;
	const [lead] = await db
		.insert(leads)
		.values({ ...buildQualifiedLeadValues(testPhone), name: `Trace ${suffix}` })
		.returning({ id: leads.id });

	assert.ok(lead);

	const [conversation] = await db
		.insert(conversations)
		.values({ leadId: lead.id })
		.returning({ id: conversations.id });

	assert.ok(conversation);

	return { conversationId: conversation.id, leadId: lead.id, testPhone };
}

test("um turno emite exatamente uma linha mariana_turn com as camadas que alteraram o texto", async () => {
	const { conversationId, leadId, testPhone } = await seedTraceLead("linha");
	const clientText = "meu telefone é 5531999998888, como funciona?";
	const capture = captureTurnTraceLines();
	let result: Awaited<ReturnType<typeof generateMarianaResponse>>;

	try {
		result = await generateMarianaResponse({
			currentMessages: [clientText],
			generateMarianaReplyFn: async () => ({
				metadata: {
					commercialAccessLevel: 1 as const,
					finishReason: "STOP",
					latencyMs: 7,
					model: "test-model",
					rawReplyHash: "aaaaaaaaaaaa",
					rawReplyLength: 10,
					requestedNextAction: "continue_qualification",
					rewrites: [],
					usage: null,
				},
				result: {
					leadUpdate: { status: "qualified" as const },
					nextAction: "continue_qualification" as const,
					reply:
						"O consórcio é uma compra planejada. Os grupos são formados por pessoas. E você, qual seu prazo?",
				},
			}),
			leadId,
			traceTurnId: "3a7f1c92-4e6b-4d81-9a5c-2f8e1b7d6c04",
		});
	} finally {
		capture.restore();
	}

	assert.equal(capture.lines.length, 1);

	const [line] = capture.lines;
	const trace = JSON.parse(line);

	assert.equal(trace.event, "mariana_turn");
	assert.equal(trace.turnId, "3a7f1c92-4e6b-4d81-9a5c-2f8e1b7d6c04");
	assert.equal(trace.conversationId, conversationId);
	assert.equal(trace.leadId, leadId);
	assert.equal(trace.outcome, "replied");
	assert.equal(trace.guardrailLayer, null);
	assert.equal(trace.rewritesReported, true);
	assert.ok(trace.requestedNextAction);
	assert.ok(trace.executedAction);
	assert.ok(
		trace.rewrites.some(
			(record: { layer: string }) => record.layer === "L6_dropped_questions"
		),
		line
	);
	assert.equal(trace.sentReplyLength, result.result.reply.length);

	// Privacidade: nem o texto do cliente, nem o telefone, nem a resposta.
	assert.equal(line.includes("telefone"), false);
	assert.equal(line.includes(testPhone), false);
	assert.equal(line.includes("5531999998888"), false);
	assert.equal(line.includes("compra planejada"), false);
	assert.equal(ELEVEN_DIGITS_IN_LINE.test(line), false);
});

test("uma exceção de guardrail ainda é registrada como guardrail_throw", async () => {
	const { leadId } = await seedTraceLead("guardrail");
	const capture = captureTurnTraceLines();

	try {
		await assert.rejects(
			() =>
				generateMarianaResponse({
					currentMessages: ["como funciona o consórcio?"],
					generateMarianaReplyFn: () => {
						const error = new Error(
							"Mariana reply violates the safety guardrails"
						);

						Object.assign(error, {
							turnGuardrailLayer: "L4_safety_assertion",
							turnRewrites: [],
						});

						return Promise.reject(error);
					},
					leadId,
					traceTurnId: "c81b5e3a-9d27-4f6c-8b40-1e7a5d2c9f63",
				}),
			/safety guardrails/
		);
	} finally {
		capture.restore();
	}

	assert.equal(capture.lines.length, 1);

	const trace = JSON.parse(capture.lines[0]);

	assert.equal(trace.outcome, "guardrail_throw");
	assert.equal(trace.guardrailLayer, "L4_safety_assertion");
	assert.equal(trace.turnId, "c81b5e3a-9d27-4f6c-8b40-1e7a5d2c9f63");
	assert.equal(trace.rewritesReported, true);
});

test("um produtor que não reporta rewrites nunca vira lista vazia", async () => {
	const { leadId } = await seedTraceLead("p2");
	const capture = captureTurnTraceLines();

	try {
		await generateMarianaResponse({
			currentMessages: ["como funciona o consórcio?"],
			// `metadata` sem `rewrites`: o produtor não reportou.
			generateMarianaReplyFn: async ({ lead }) => buildAiResponse(lead),
			leadId,
			traceTurnId: "6d4e8b1f-2a79-4c35-9e68-3b1d7f5a2c80",
		});
	} finally {
		capture.restore();
	}

	assert.equal(capture.lines.length, 1);

	const trace = JSON.parse(capture.lines[0]);

	assert.equal(trace.rewritesReported, false);
	assert.equal(trace.rewrites, null);
	assert.equal(trace.pureBackendText, null);
});

test("um turno que falha depois da chamada ao modelo ainda emite uma linha", async () => {
	const { leadId } = await seedTraceLead("turnerror");
	const schedulingAvailabilityService = new SchedulingAvailabilityService();

	// Falha depois de um turno de modelo bem-sucedido: o caso que não emitia
	// linha nenhuma (defeito C-1).
	schedulingAvailabilityService.getAvailableSlots = () =>
		Promise.reject(new Error("calendar is down"));

	const capture = captureTurnTraceLines();

	try {
		await assert.rejects(
			() =>
				generateMarianaResponse({
					currentMessages: [
						"Olá, quais horários para reunião vocês têm disponíveis?",
					],
					generateMarianaReplyFn: async ({ lead }) => buildAiResponse(lead),
					leadId,
					schedulingAvailabilityService,
					traceTurnId: "f4c92e18-6b35-4a7d-8e21-9c5a3f7b1d60",
				}),
			/calendar is down/
		);
	} finally {
		capture.restore();
	}

	assert.equal(capture.lines.length, 1);

	const trace = JSON.parse(capture.lines[0]);

	assert.equal(trace.outcome, "turn_error");
	assert.equal(trace.guardrailLayer, null);
	assert.equal(trace.turnId, "f4c92e18-6b35-4a7d-8e21-9c5a3f7b1d60");
	// O modelo respondeu: os dados dele continuam no rastro.
	assert.equal(trace.modelVersionReturned, null);
	assert.equal(trace.sentReplyHash, null);
});

test("o rastro não inventa latência, versão de modelo nem hash cru", async () => {
	const { leadId } = await seedTraceLead("honesty");
	const capture = captureTurnTraceLines();

	try {
		await generateMarianaResponse({
			currentMessages: ["como funciona o consórcio?"],
			// `metadata` sem rewrites, sem latência e sem versão devolvida.
			generateMarianaReplyFn: async ({ lead }) => buildAiResponse(lead),
			leadId,
			traceTurnId: "8b3d6a4f-1c72-4e95-8a60-2d7f4b1e9c38",
		});
	} finally {
		capture.restore();
	}

	const trace = JSON.parse(capture.lines[0]);

	// C-2: a API não devolveu versão, então o campo "returned" não a inventa.
	assert.equal(trace.modelVersionReturned, null);
	// C-3: sem relato do produtor, o hash "cru" seria o texto pós-L1/L3.
	assert.equal(trace.rewritesReported, false);
	assert.equal(trace.rawReplyHash, null);
	assert.equal(trace.rawReplyLength, null);
	// C-4: a ação foi rebaixada, e o rastro diz por quê.
	assert.equal(trace.actionBlockedReason, "no_current_scheduling_intent");
});

test("um guardrail não reporta latência medida", async () => {
	const { leadId } = await seedTraceLead("latency");
	const capture = captureTurnTraceLines();

	try {
		await assert.rejects(
			() =>
				generateMarianaResponse({
					currentMessages: ["como funciona o consórcio?"],
					generateMarianaReplyFn: () => {
						const error = new Error(
							"Mariana reply violates the safety guardrails"
						);

						Object.assign(error, {
							turnGuardrailLayer: "L4_safety_assertion",
							turnRewrites: [],
						});

						return Promise.reject(error);
					},
					leadId,
					traceTurnId: "5e1a7c93-4d28-4b6f-9c05-3a8e2f6d1b74",
				}),
			/safety guardrails/
		);
	} finally {
		capture.restore();
	}

	const trace = JSON.parse(capture.lines[0]);

	// C-2: nenhuma medição não é latência zero.
	assert.equal(trace.latencyMs, null);
	assert.equal(trace.rawReplyHash, null);
});

test("uma falha de modelo é registrada como model_error, não turn_error", async () => {
	const { leadId } = await seedTraceLead("modelerror");
	const capture = captureTurnTraceLines();

	try {
		await assert.rejects(
			() =>
				generateMarianaResponse({
					currentMessages: ["como funciona o consórcio?"],
					generateMarianaReplyFn: () =>
						Promise.reject(
							new ModelUnavailableError(
								"Gemini request failed before producing a response",
								{ kind: "transport" }
							)
						),
					leadId,
					traceTurnId: "7a2e5d81-3f94-4c62-8b17-6e0a9d4f2c53",
				}),
			ModelUnavailableError
		);
	} finally {
		capture.restore();
	}

	assert.equal(capture.lines.length, 1);

	const trace = JSON.parse(capture.lines[0]);

	assert.equal(trace.outcome, "model_error");
	assert.equal(trace.guardrailLayer, null);
	assert.equal(trace.latencyMs, null);
});
