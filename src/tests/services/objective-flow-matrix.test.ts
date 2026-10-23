/** biome-ignore-all lint/performance/useTopLevelRegex: <> */
/** biome-ignore-all lint/suspicious/useAwait: <> */
/** biome-ignore-all lint/performance/noAwaitInLoops: <> */
// Phase 4 test matrix for the objective conversation flow. Gemini is scripted
// at the client, Google Calendar and WhatsApp are mocked at the prototype:
// nothing leaves the machine.
import assert from "node:assert/strict";
import test from "node:test";

import { and, asc, eq } from "drizzle-orm";

import {
	COMMERCIAL_HANDOFF,
	CONSULTANT_OFFER_TEXT,
} from "../../ai/knowledge/commercial-policy";
import { closeDatabase, db } from "../../db/connections";
import {
	appointments,
	autonomousTasks,
	conversations,
	outboundMessages,
	schedulingSessions,
	schedulingSlots,
} from "../../db/schema";
import { GoogleCalendarService } from "../../integrations/google-calendar/google-calendar-service";
import { WhatsAppService } from "../../integrations/whatsapp/whatsapp-service";
import { executeNextAutonomousTask } from "../../services/conversations/autonomous-task-executor";
import {
	createAutonomousTaskHandlers,
	PROCESS_BUTTON_REPLY_TASK,
	PROCESS_CONSULTANT_PREFERENCE_REPLY_TASK,
	SEND_CONFIRMATION_REQUEST_TASK,
} from "../../services/conversations/autonomous-task-handlers";
import {
	CONSULTANT_REASON_QUESTION,
	CURRENT_SITUATION_QUESTION,
	NAME_QUESTION,
	PAIN_POINT_QUESTION,
	REASON_QUESTION,
} from "../../services/leads/qualification-gaps";
import {
	buildFakeAvailabilityService,
	cleanupConversationFixture,
	createConversationFixture,
	loadAssistantMessages,
	loadLead,
	type RecordedTurn,
	runScriptedConversation,
	type ScriptedGeminiResult,
	seedHistory,
	updateLeadFixture,
} from "../support/conversation-harness";
import {
	countSentences,
	questionSentences,
} from "../support/simulation-checks";

test.after(async () => {
	await closeDatabase();
});

const QUALIFYING = { status: "qualifying" as const };

function gemini(
	reply: string,
	leadUpdate: Partial<ScriptedGeminiResult["leadUpdate"]> = {},
	nextAction: ScriptedGeminiResult["nextAction"] = "continue_qualification"
): ScriptedGeminiResult {
	return { leadUpdate: { ...QUALIFYING, ...leadUpdate }, nextAction, reply };
}

// Scenario 10: every conversational reply is short and asks at most once.
function assertReplyShape(turns: RecordedTurn[]) {
	for (const turn of turns) {
		if (turn.result.schedulingOffer) {
			continue;
		}
		assert.ok(
			countSentences(turn.assistant) <= 3,
			`more than 3 sentences: ${turn.assistant}`
		);
		assert.ok(
			(turn.assistant.match(/\?/g) ?? []).length <= 1,
			`more than 1 question: ${turn.assistant}`
		);
	}
}

function assertNoRepeatedQuestion(turns: RecordedTurn[]) {
	const seen = new Set<string>();
	for (const turn of turns) {
		for (const question of questionSentences(turn.assistant)) {
			assert.ok(!seen.has(question), `repeated question: ${question}`);
			seen.add(question);
		}
	}
}

async function withFixture(
	options: Parameters<typeof createConversationFixture>[0],
	run: (fixture: { conversationId: string; leadId: string }) => Promise<void>
) {
	const fixture = await createConversationFixture(options);
	try {
		await run(fixture);
	} finally {
		await cleanupConversationFixture(fixture.leadId);
	}
}

function mockExternalServices() {
	const originals = {
		createEvent: GoogleCalendarService.prototype.createEvent,
		deleteEvent: GoogleCalendarService.prototype.deleteEvent,
		getBusyPeriods: GoogleCalendarService.prototype.getBusyPeriods,
		sendReplyButtonsMessage: WhatsAppService.prototype.sendReplyButtonsMessage,
		sendTextMessage: WhatsAppService.prototype.sendTextMessage,
	};
	const calendarEvents: string[] = [];

	GoogleCalendarService.prototype.createEvent = async function createEvent({
		end,
		start,
	}: {
		end: Date;
		start: Date;
	}) {
		calendarEvents.push(start.toISOString());
		return {
			end: end.toISOString(),
			id: `fake-event-${calendarEvents.length}`,
			start: start.toISOString(),
		};
	} as unknown as typeof GoogleCalendarService.prototype.createEvent;
	GoogleCalendarService.prototype.deleteEvent = async () => undefined;
	GoogleCalendarService.prototype.getBusyPeriods = async (
		calendarIds: string[]
	) =>
		calendarIds.map((calendarId) => ({
			busy: [],
			calendarId,
		})) as unknown as Awaited<
			ReturnType<typeof GoogleCalendarService.prototype.getBusyPeriods>
		>;
	const fakeSend = async () => ({
		contacts: [],
		messages: [{ id: `wamid.test_${Date.now()}_${Math.random()}` }],
		messaging_product: "whatsapp",
	});
	WhatsAppService.prototype.sendReplyButtonsMessage =
		fakeSend as unknown as typeof WhatsAppService.prototype.sendReplyButtonsMessage;
	WhatsAppService.prototype.sendTextMessage =
		fakeSend as unknown as typeof WhatsAppService.prototype.sendTextMessage;

	return {
		calendarEvents,
		restore() {
			Object.assign(GoogleCalendarService.prototype, {
				createEvent: originals.createEvent,
				deleteEvent: originals.deleteEvent,
				getBusyPeriods: originals.getBusyPeriods,
			});
			Object.assign(WhatsAppService.prototype, {
				sendReplyButtonsMessage: originals.sendReplyButtonsMessage,
				sendTextMessage: originals.sendTextMessage,
			});
		},
	};
}

async function enqueueTask(
	conversationId: string,
	taskType: string,
	payload: Record<string, unknown>
) {
	await db.insert(autonomousTasks).values({
		availableAt: new Date(),
		conversationId,
		idempotencyKey: `matrix:${taskType}:${Date.now()}:${Math.random()}`,
		maxAttempts: 5,
		maxSteps: 8,
		payload,
		status: "pending",
		taskType,
	});
}

async function runNextTask(conversationId: string) {
	const result = await executeNextAutonomousTask({
		conversationId,
		handlers: createAutonomousTaskHandlers(),
	});
	assert.equal(result.status, "completed", JSON.stringify(result));
}

test("2. caminho feliz: oi → nome → motivo → oferta → sim → horários → confirmação → appointment", async () => {
	const external = mockExternalServices();
	try {
		await withFixture({}, async ({ conversationId, leadId }) => {
			const calendarCalls = { count: 0 };
			const turns = await runScriptedConversation({
				leadId,
				schedulingAvailabilityService:
					buildFakeAvailabilityService(calendarCalls),
				turns: [
					{
						gemini: gemini("Olá! Eu sou a Mariana. Qual é o seu nome?"),
						user: ["oi"],
					},
					{
						gemini: gemini("Prazer, Davi!", { name: "Davi" }),
						user: ["Davi"],
					},
					{
						gemini: gemini("Entendi! Que legal.", {
							consortiumType: "veículo",
							objective: "comprar um carro novo",
						}),
						user: ["quero um carro novo"],
					},
					{
						gemini: gemini("Ótimo!", {}, "continue_qualification"),
						user: ["sim"],
					},
				],
			});

			assert.equal(
				turns[0]?.assistant,
				`Olá! Eu sou a Mariana. ${NAME_QUESTION}`
			);
			assert.equal(turns[1]?.assistant, `Prazer, Davi! ${REASON_QUESTION}`);
			assert.ok(turns[2]?.assistant.endsWith(CONSULTANT_OFFER_TEXT));
			const offer = turns[3]?.result.schedulingOffer;
			assert.ok(offer, turns[3]?.assistant);
			assert.equal(offer.slots.length, 3);
			assert.equal(calendarCalls.count, 1);
			assertReplyShape(turns);
			assertNoRepeatedQuestion(turns);

			const leadAfterOffer = await loadLead(leadId);
			assert.equal(leadAfterOffer.name, "Davi");
			assert.equal(leadAfterOffer.status, "qualified");

			// Preference question (enqueued by the offer) → no preference →
			// slot → confirmation request → confirm.
			await runNextTask(conversationId);
			const sessionId = offer.session.id;
			await enqueueTask(
				conversationId,
				PROCESS_CONSULTANT_PREFERENCE_REPLY_TASK,
				{
					buttonId: `pref:${sessionId}:no_preference`,
					eventExternalId: "matrix-pref",
					eventId: sessionId,
					kind: "button_reply",
				}
			);
			await runNextTask(conversationId);

			const [firstSlot] = await db
				.select()
				.from(schedulingSlots)
				.where(eq(schedulingSlots.schedulingSessionId, sessionId))
				.orderBy(asc(schedulingSlots.position));
			assert.ok(firstSlot);
			await enqueueTask(conversationId, SEND_CONFIRMATION_REQUEST_TASK, {
				buttonId: firstSlot.id,
				eventExternalId: "matrix-slot",
				eventId: sessionId,
				kind: "button_reply",
			});
			await runNextTask(conversationId);

			const [sessionBeforeConfirm] = await db
				.select()
				.from(schedulingSessions)
				.where(eq(schedulingSessions.id, sessionId));
			assert.equal(sessionBeforeConfirm?.selectedSlotId, firstSlot.id);

			await enqueueTask(conversationId, PROCESS_BUTTON_REPLY_TASK, {
				buttonId: `confirm:${firstSlot.id}`,
				eventExternalId: "matrix-confirm",
				kind: "button_reply",
			});
			await runNextTask(conversationId);

			const savedAppointments = await db
				.select()
				.from(appointments)
				.where(eq(appointments.leadId, leadId));
			assert.equal(savedAppointments.length, 1);
			assert.equal(savedAppointments[0]?.status, "confirmed");
			assert.equal(external.calendarEvents.length, 1);
			assert.equal((await loadLead(leadId)).status, "scheduled");

			const outbound = await db
				.select({ payload: outboundMessages.payload })
				.from(outboundMessages)
				.where(eq(outboundMessages.conversationId, conversationId));
			assert.ok(
				outbound.some((row) =>
					JSON.stringify(row.payload).includes("Agendamento confirmado para")
				),
				"confirmation message must be queued"
			);
		});
	} finally {
		external.restore();
	}
});

test("3. pedido explícito logo no início: uma pergunta de motivo e depois horários", async () => {
	await withFixture({ name: "Davi" }, async ({ leadId }) => {
		const turns = await runScriptedConversation({
			leadId,
			schedulingAvailabilityService: buildFakeAvailabilityService({ count: 0 }),
			turns: [
				{
					gemini: gemini(
						"Olá, Davi! Eu sou a Mariana. Claro, vou te ajudar a falar com um consultor. Sobre o que você quer conversar?",
						{},
						"request_consultant"
					),
					user: ["oi, quero falar com um consultor"],
				},
				{
					gemini: gemini("Entendi!", { objective: "comprar um apartamento" }),
					user: ["quero comprar um apartamento"],
				},
			],
		});

		assert.ok(turns[0]?.assistant.endsWith(CONSULTANT_REASON_QUESTION));
		assert.equal(
			turns.filter((turn) =>
				turn.assistant.includes(CONSULTANT_REASON_QUESTION)
			).length,
			1
		);
		assert.ok(turns[1]?.result.schedulingOffer, turns[1]?.assistant);
		assertReplyShape(turns);
	});
});

test("4a. 'sim' depois de CONSULTANT_OFFER_TEXT inicia o fluxo de horários", async () => {
	await withFixture({ name: "Davi" }, async ({ conversationId, leadId }) => {
		await updateLeadFixture(leadId, {
			objective: "comprar um carro novo",
			status: "qualifying",
		});
		await seedHistory(conversationId, [
			{ content: "quero um carro novo", role: "user" },
			{ content: `Entendi! ${CONSULTANT_OFFER_TEXT}`, role: "assistant" },
		]);

		const [turn] = await runScriptedConversation({
			leadId,
			schedulingAvailabilityService: buildFakeAvailabilityService({ count: 0 }),
			turns: [{ gemini: gemini("Certo!"), user: ["sim"] }],
		});

		assert.ok(turn?.result.schedulingOffer, turn?.assistant);
	});
});

test("4b. 'sim' depois de outra mensagem não oferece horários", async () => {
	await withFixture({ name: "Davi" }, async ({ conversationId, leadId }) => {
		const calendarCalls = { count: 0 };
		await updateLeadFixture(leadId, {
			objective: "comprar um carro novo",
			status: "qualifying",
		});
		await seedHistory(conversationId, [
			{ content: "quero um carro novo", role: "user" },
			{ content: `Entendi! ${CONSULTANT_OFFER_TEXT}`, role: "assistant" },
			{ content: "tenho um carro usado", role: "user" },
			{ content: `Entendi. ${PAIN_POINT_QUESTION}`, role: "assistant" },
		]);

		const [turn] = await runScriptedConversation({
			leadId,
			schedulingAvailabilityService:
				buildFakeAvailabilityService(calendarCalls),
			turns: [
				{
					gemini: gemini(
						"Perfeito! Vou verificar os horários.",
						{},
						"offer_meeting"
					),
					user: ["sim"],
				},
			],
		});

		assert.equal(turn?.result.schedulingOffer, undefined);
		assert.equal(calendarCalls.count, 0);
		assert.equal((await loadLead(leadId)).interestedInConsultant, false);
	});
});

test("4c. 'não, agora não' depois da oferta: sem horários, conversa segue educada", async () => {
	await withFixture({ name: "Davi" }, async ({ conversationId, leadId }) => {
		const calendarCalls = { count: 0 };
		await updateLeadFixture(leadId, {
			objective: "comprar um carro novo",
			status: "qualifying",
		});
		await seedHistory(conversationId, [
			{ content: "quero um carro novo", role: "user" },
			{ content: `Entendi! ${CONSULTANT_OFFER_TEXT}`, role: "assistant" },
		]);

		const [turn] = await runScriptedConversation({
			leadId,
			schedulingAvailabilityService:
				buildFakeAvailabilityService(calendarCalls),
			turns: [
				{
					gemini: gemini(
						"Tudo bem, sem problemas! Quer conversar com um consultor depois?"
					),
					user: ["não, agora não"],
				},
			],
		});

		assert.equal(turn?.result.schedulingOffer, undefined);
		assert.equal(calendarCalls.count, 0);
		assert.equal(
			turn?.assistant,
			`Tudo bem, sem problemas! ${CURRENT_SITUATION_QUESTION}`
		);
		assert.ok(!turn?.assistant.includes(CONSULTANT_OFFER_TEXT));
	});
});

test("5. opcionais faltando nunca bloqueiam a oferta e cada um é perguntado no máximo uma vez", async () => {
	await withFixture({ name: "Davi" }, async ({ conversationId, leadId }) => {
		const turns = await runScriptedConversation({
			leadId,
			schedulingAvailabilityService: buildFakeAvailabilityService({ count: 0 }),
			turns: [
				{ gemini: gemini("Olá, Davi! Eu sou a Mariana."), user: ["oi"] },
				{
					gemini: gemini("Entendi!", { objective: "comprar uma moto" }),
					user: ["quero uma moto"],
				},
				{
					gemini: gemini("Claro! O consórcio é uma compra planejada em grupo."),
					user: ["como funciona o consórcio?"],
				},
				{ gemini: gemini("Certo."), user: ["não sei"] },
				{ gemini: gemini("Entendi."), user: ["prefiro não dizer"] },
				{ gemini: gemini("Ok."), user: ["hmm"] },
				{ gemini: gemini("Claro!"), user: ["quero ver os horários"] },
			],
		});

		const replies = await loadAssistantMessages(conversationId);
		for (const question of [CURRENT_SITUATION_QUESTION, PAIN_POINT_QUESTION]) {
			assert.ok(
				replies.filter((reply) => reply.includes(question)).length <= 1,
				question
			);
		}
		const lead = await loadLead(leadId);
		assert.equal(lead.currentSituation, null);
		assert.equal(lead.painPoint, null);
		const lastTurn = turns.at(-1);
		assert.ok(lastTurn?.result.schedulingOffer, lastTurn?.assistant ?? "");
		assertReplyShape(turns);
		assertNoRepeatedQuestion(turns);
	});
});

test("6. mensagem com vários campos preenche currentSituation + objective e nenhum é perguntado de novo", async () => {
	await withFixture({ name: "Davi" }, async ({ leadId }) => {
		const turns = await runScriptedConversation({
			leadId,
			schedulingAvailabilityService: buildFakeAvailabilityService({ count: 0 }),
			turns: [
				{ gemini: gemini("Olá, Davi! Eu sou a Mariana."), user: ["oi"] },
				{
					gemini: gemini("Entendi!", {
						currentSituation: "tem um carro usado",
						objective: "comprar um carro novo",
					}),
					user: ["tenho um carro usado e quero um novo"],
				},
				{ gemini: gemini("Tudo bem."), user: ["agora não"] },
				{ gemini: gemini("Certo."), user: ["vontade de trocar"] },
			],
		});

		const lead = await loadLead(leadId);
		assert.equal(lead.currentSituation, "tem um carro usado");
		assert.equal(lead.objective, "comprar um carro novo");
		assert.equal(lead.consortiumType, "veículo");
		for (const turn of turns.slice(2)) {
			assert.ok(!turn.assistant.includes(CURRENT_SITUATION_QUESTION));
			assert.ok(!turn.assistant.includes(REASON_QUESTION));
		}
		assertReplyShape(turns);
	});
});

test("7. 'já disse isso' gera desculpa e avança sem repetir", async () => {
	await withFixture({ name: "Davi" }, async ({ conversationId, leadId }) => {
		await seedHistory(conversationId, [
			{ content: "oi, quero um carro", role: "user" },
			{ content: `Olá, Davi! ${REASON_QUESTION}`, role: "assistant" },
		]);

		const [turn] = await runScriptedConversation({
			leadId,
			schedulingAvailabilityService: buildFakeAvailabilityService({ count: 0 }),
			turns: [
				{
					gemini: gemini("Entendi, um carro.", {
						objective: "comprar um carro",
					}),
					user: ["eu já disse isso, um carro"],
				},
			],
		});

		assert.match(turn?.assistant ?? "", /^Desculpe!/);
		assert.ok(turn?.assistant.endsWith(CONSULTANT_OFFER_TEXT), turn?.assistant);
		assert.ok(!turn?.assistant.includes(REASON_QUESTION));
	});
});

for (const question of [
	"quanto fica a parcela?",
	"qual a taxa?",
	"quanto de lance?",
]) {
	test(`8. pergunta sensível '${question}' → handoff + CONSULTANT_OFFER_TEXT, sem números`, async () => {
		await withFixture({ name: "Davi" }, async ({ conversationId, leadId }) => {
			await updateLeadFixture(leadId, {
				objective: "comprar um carro novo",
				status: "qualifying",
			});
			await seedHistory(conversationId, [
				{ content: "quero um carro novo", role: "user" },
				{ content: "Entendi!", role: "assistant" },
			]);

			const turns = await runScriptedConversation({
				leadId,
				schedulingAvailabilityService: buildFakeAvailabilityService({
					count: 0,
				}),
				turns: [
					// Not consumed: level-3 questions never reach Gemini.
					{ gemini: gemini("A parcela fica em R$ 500."), user: [question] },
					{ gemini: gemini("Ótimo!"), user: ["sim"] },
				],
			});

			assert.equal(turns[0]?.assistant, COMMERCIAL_HANDOFF);
			assert.ok(turns[0]?.assistant.endsWith(CONSULTANT_OFFER_TEXT));
			assert.doesNotMatch(turns[0]?.assistant ?? "", /\d/);
			assert.ok(turns[1]?.result.schedulingOffer, turns[1]?.assistant);
		});
	});
}

test("8b. valor informado pelo cliente é registrado, sem handoff", async () => {
	await withFixture({ name: "Davi" }, async ({ conversationId, leadId }) => {
		await updateLeadFixture(leadId, {
			objective: "comprar um imóvel",
			status: "qualifying",
		});
		await seedHistory(conversationId, [
			{ content: "quero um imóvel", role: "user" },
			{ content: "Entendi!", role: "assistant" },
		]);

		const [turn] = await runScriptedConversation({
			leadId,
			schedulingAvailabilityService: buildFakeAvailabilityService({ count: 0 }),
			turns: [
				{
					gemini: gemini("Anotado, um crédito de R$ 100 mil."),
					user: ["quero um crédito de R$ 100 mil"],
				},
			],
		});

		assert.notEqual(turn?.assistant, COMMERCIAL_HANDOFF);
		assert.match(
			turn?.assistant ?? "",
			/^Anotado, um crédito de R\$ 100 mil\./
		);
	});
});

test("9. cumprimento só na primeira resposta", async () => {
	await withFixture({ name: "Davi" }, async ({ leadId }) => {
		const turns = await runScriptedConversation({
			leadId,
			schedulingAvailabilityService: buildFakeAvailabilityService({ count: 0 }),
			turns: [
				{ gemini: gemini("Olá, Davi! Eu sou a Mariana."), user: ["oi"] },
				{
					gemini: gemini("Oi de novo, Davi! Entendi.", {
						objective: "comprar um carro",
					}),
					user: ["oi, quero um carro"],
				},
			],
		});

		assert.match(turns[0]?.assistant ?? "", /^Olá, Davi!/);
		assert.doesNotMatch(turns[1]?.assistant ?? "", /^(Oi|Olá)/);
		assert.equal(turns[1]?.assistant, `Entendi. ${CONSULTANT_OFFER_TEXT}`);
	});
});

test("11a. aceite antigo não autoriza um turno posterior", async () => {
	await withFixture({ name: "Davi" }, async ({ conversationId, leadId }) => {
		const calendarCalls = { count: 0 };
		await updateLeadFixture(leadId, {
			objective: "comprar um carro novo",
			status: "qualifying",
		});
		await seedHistory(conversationId, [
			{ content: `Entendi! ${CONSULTANT_OFFER_TEXT}`, role: "assistant" },
			{ content: "como funciona o sorteio?", role: "user" },
			{ content: "O sorteio acontece nas assembleias.", role: "assistant" },
		]);

		const [turn] = await runScriptedConversation({
			leadId,
			schedulingAvailabilityService:
				buildFakeAvailabilityService(calendarCalls),
			turns: [{ gemini: gemini("Ótimo!", {}, "offer_meeting"), user: ["sim"] }],
		});

		assert.equal(turn?.result.schedulingOffer, undefined);
		assert.equal(calendarCalls.count, 0);
	});
});

test("11b. lead menor de 18 nunca recebe horários", async () => {
	await withFixture(
		{ birthDate: new Date("2012-01-01"), name: "Davi" },
		async ({ conversationId, leadId }) => {
			const calendarCalls = { count: 0 };
			await updateLeadFixture(leadId, {
				objective: "comprar um carro novo",
				status: "qualifying",
			});
			await seedHistory(conversationId, [
				{ content: `Entendi! ${CONSULTANT_OFFER_TEXT}`, role: "assistant" },
			]);

			let offered = false;
			try {
				const [turn] = await runScriptedConversation({
					leadId,
					schedulingAvailabilityService:
						buildFakeAvailabilityService(calendarCalls),
					turns: [
						{
							gemini: gemini("Ótimo!"),
							user: ["sim, quero falar com um consultor"],
						},
					],
				});
				offered = Boolean(turn?.result.schedulingOffer);
			} catch (error) {
				assert.match(String(error), /at least 18/);
			}

			assert.equal(offered, false);
			assert.equal(calendarCalls.count, 0);
			assert.notEqual((await loadLead(leadId)).status, "qualified");
		}
	);
});

test("11c. close continua close mesmo com pedido explícito", async () => {
	await withFixture({ name: "Davi" }, async ({ conversationId, leadId }) => {
		const calendarCalls = { count: 0 };
		await updateLeadFixture(leadId, {
			objective: "comprar um carro novo",
			status: "qualifying",
		});
		await seedHistory(conversationId, [
			{ content: "Entendi!", role: "assistant" },
		]);

		const [turn] = await runScriptedConversation({
			leadId,
			schedulingAvailabilityService:
				buildFakeAvailabilityService(calendarCalls),
			turns: [
				{
					gemini: gemini("Até mais!", {}, "close"),
					user: ["quero falar com um consultor"],
				},
			],
		});

		assert.equal(turn?.result.actionResult.action, "close");
		assert.equal(turn?.result.schedulingOffer, undefined);
		assert.equal(calendarCalls.count, 0);
		const [conversation] = await db
			.select({ status: conversations.status })
			.from(conversations)
			.where(eq(conversations.id, conversationId));
		assert.equal(conversation?.status, "closed");
	});
});

test("11d. pedido explícito com sessão ativa não cria segunda sessão ativa", async () => {
	await withFixture({ name: "Davi" }, async ({ leadId }) => {
		const service = buildFakeAvailabilityService({ count: 0 });
		const first = await runScriptedConversation({
			leadId,
			schedulingAvailabilityService: service,
			turns: [
				{
					gemini: gemini("Claro!", { objective: "comprar um carro" }),
					user: ["quero um carro e quero falar com um consultor"],
				},
			],
		});
		assert.ok(first[0]?.result.schedulingOffer, first[0]?.assistant);

		await runScriptedConversation({
			leadId,
			schedulingAvailabilityService: service,
			turns: [{ gemini: gemini("Claro!"), user: ["quero ver os horários"] }],
		});

		const active = await db
			.select({ id: schedulingSessions.id })
			.from(schedulingSessions)
			.where(
				and(
					eq(schedulingSessions.leadId, leadId),
					eq(schedulingSessions.status, "active")
				)
			);
		assert.equal(active.length, 1);
	});
});
