/** biome-ignore-all lint/performance/useTopLevelRegex: <> */
import assert from "node:assert/strict";
import test from "node:test";

import { closeDatabase } from "../../db/connections";
import {
	buildFakeAvailabilityService,
	cleanupConversationFixture,
	createConversationFixture,
	loadLead,
	runScriptedConversation,
	type ScriptedTurn,
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

const OFFER_TEXT =
	"Você quer que eu procure um horário para conversar com um consultor?";

// Production transcript (lead 3cc1444c-…), with the Gemini outputs that were
// actually observed: free-text questions, a free-text consultant offer and
// `offer_meeting` requests.
const PRODUCTION_TURNS: ScriptedTurn[] = [
	{
		gemini: {
			leadUpdate: { status: "qualifying" },
			nextAction: "ask_next_qualification_question",
			reply:
				"Olá, Davi! Boa noite! Eu sou a Mariana. Para eu te orientar melhor, qual é o seu principal objetivo com o consórcio?",
		},
		user: [
			"Ola Mariana boa noite meu nome é Davi",
			"eu quero fazer um consorcio",
		],
	},
	{
		gemini: {
			leadUpdate: {
				consortiumType: "veículo",
				objective: "comprar um carro novo",
				status: "qualifying",
			},
			nextAction: "ask_next_qualification_question",
			reply:
				"Entendi, Davi! Qual é a sua situação atual em relação a esse objetivo? Por exemplo, você já possui um veículo?",
		},
		user: ["eu quero comprar um carro novo"],
	},
	{
		gemini: {
			leadUpdate: {
				painPoint: "já tem um veículo usado e quer um novo",
				status: "qualifying",
			},
			nextAction: "ask_next_qualification_question",
			reply:
				"Entendi! Qual é a sua principal motivação para trocar de carro agora?",
		},
		user: [
			"eu ja tenho um veiculo mas ele é usado",
			"mas agora eu quero um novinho",
		],
	},
	{
		gemini: {
			leadUpdate: { painPoint: "necessidade", status: "qualifying" },
			nextAction: "offer_meeting",
			reply:
				"Você gostaria de conversar com um consultor especializado para entender as opções?",
		},
		user: ["necessidade"],
	},
	{
		gemini: {
			leadUpdate: { status: "qualifying" },
			nextAction: "offer_meeting",
			reply:
				"Você está pensando em consórcio de imóvel, de veículo ou de outro tipo de bem?",
		},
		user: ["sim gostaria"],
	},
	{
		gemini: {
			leadUpdate: { consortiumType: "veículo", status: "qualifying" },
			nextAction: "ask_next_qualification_question",
			reply:
				"Desculpe! Para eu entender melhor o seu momento, como está a sua situação hoje em relação a esse objetivo?",
		},
		user: ["eu ja disse isso", "veiculo"],
	},
	{
		gemini: {
			leadUpdate: { status: "qualifying" },
			nextAction: "continue_qualification",
			reply:
				"Me conta um pouco mais: hoje, como você está em relação a esse objetivo?",
		},
		user: ["eu quero comprar um carro novo", "eu posso falar com o consultor?"],
	},
];

const ANSWERED_TOPIC_QUESTIONS = [
	{
		answeredAtTurn: 1,
		pattern:
			/objetivo com o cons[oó]rcio|tipo de bem|im[oó]vel, de ve[ií]culo/i,
	},
	{ answeredAtTurn: 2, pattern: /situa[cç][aã]o/i },
	{ answeredAtTurn: 3, pattern: /motiva/i },
];

test("transcript de produção chega ao fluxo de horários sem repetir perguntas", async () => {
	const fixture = await createConversationFixture({ name: "Davi" });
	const calendarCalls = { count: 0 };

	try {
		const turns = await runScriptedConversation({
			leadId: fixture.leadId,
			schedulingAvailabilityService:
				buildFakeAvailabilityService(calendarCalls),
			turns: PRODUCTION_TURNS,
		});

		const offerTurn = turns.findIndex((turn) => turn.result.schedulingOffer);
		assert.notEqual(
			offerTurn,
			-1,
			`offer flow never started. Replies:\n${turns.map((turn) => turn.assistant).join("\n---\n")}`
		);

		const seenQuestions = new Set<string>();
		for (const [index, turn] of turns.entries()) {
			if (!turn.result.schedulingOffer) {
				assert.ok(countSentences(turn.assistant) <= 3, turn.assistant);
				assert.ok(
					(turn.assistant.match(/\?/g) ?? []).length <= 1,
					turn.assistant
				);
			}
			for (const question of questionSentences(turn.assistant)) {
				assert.ok(
					!seenQuestions.has(question),
					`turn ${index + 1} repeated a question: ${question}`
				);
				seenQuestions.add(question);
			}

			for (const { answeredAtTurn, pattern } of ANSWERED_TOPIC_QUESTIONS) {
				if (index > answeredAtTurn && !turn.result.schedulingOffer) {
					assert.ok(
						!questionSentences(turn.assistant).some((question) =>
							pattern.test(question)
						),
						`turn ${index + 1} re-asked an answered field: ${turn.assistant}`
					);
				}
			}
		}

		const lead = await loadLead(fixture.leadId);
		assert.equal(lead.status, "qualified");
		assert.equal(lead.interestedInConsultant, true);
		assert.ok(lead.currentSituation, "currentSituation should be captured");
	} finally {
		await cleanupConversationFixture(fixture.leadId);
	}
});

// RC1 — a missing optional field must not block the offer.
test("RC1: lead sem currentSituation e painPoint recebe horários ao aceitar a oferta", async () => {
	const fixture = await createConversationFixture({ name: "Davi" });
	const calendarCalls = { count: 0 };

	try {
		await updateLeadFixture(fixture.leadId, {
			consortiumType: "veículo",
			objective: "comprar um carro novo",
			status: "qualifying",
		});
		await seedHistory(fixture.conversationId, [
			{ content: "quero comprar um carro novo", role: "user" },
			{ content: `Entendi! ${OFFER_TEXT}`, role: "assistant" },
		]);

		const [turn] = await runScriptedConversation({
			leadId: fixture.leadId,
			schedulingAvailabilityService:
				buildFakeAvailabilityService(calendarCalls),
			turns: [
				{
					gemini: {
						leadUpdate: { status: "qualifying" },
						nextAction: "continue_qualification",
						reply: "Perfeito! Como está a sua situação hoje?",
					},
					user: ["sim"],
				},
			],
		});

		assert.ok(turn?.result.schedulingOffer, turn?.assistant);
	} finally {
		await cleanupConversationFixture(fixture.leadId);
	}
});

// RC2 — the backend, not Gemini, chooses the question.
test("RC2: pergunta do Gemini sobre campo já respondido não chega ao cliente", async () => {
	const fixture = await createConversationFixture({ name: "Davi" });

	try {
		await updateLeadFixture(fixture.leadId, {
			consortiumType: "veículo",
			objective: "comprar um carro novo",
			status: "qualifying",
		});
		await seedHistory(fixture.conversationId, [
			{ content: "quero comprar um carro novo", role: "user" },
			{ content: "Entendi!", role: "assistant" },
		]);

		const [turn] = await runScriptedConversation({
			leadId: fixture.leadId,
			schedulingAvailabilityService: buildFakeAvailabilityService({ count: 0 }),
			turns: [
				{
					gemini: {
						leadUpdate: { status: "qualifying" },
						reply:
							"Certo! Você está pensando em consórcio de imóvel, de veículo ou de outro tipo de bem?",
					},
					user: ["ok"],
				},
			],
		});

		assert.doesNotMatch(turn?.assistant ?? "", /tipo de bem/);
	} finally {
		await cleanupConversationFixture(fixture.leadId);
	}
});

// RC3 — an explicit request overrides pending qualification questions.
test("RC3: pedido explícito de consultor com motivo conhecido inicia o fluxo de horários", async () => {
	const fixture = await createConversationFixture({ name: "Davi" });
	const calendarCalls = { count: 0 };

	try {
		await updateLeadFixture(fixture.leadId, {
			consortiumType: "veículo",
			objective: "comprar um carro novo",
			status: "qualifying",
		});
		await seedHistory(fixture.conversationId, [
			{ content: "quero comprar um carro novo", role: "user" },
			{ content: "Entendi!", role: "assistant" },
		]);

		const [turn] = await runScriptedConversation({
			leadId: fixture.leadId,
			schedulingAvailabilityService:
				buildFakeAvailabilityService(calendarCalls),
			turns: [
				{
					gemini: {
						leadUpdate: { status: "qualifying" },
						nextAction: "continue_qualification",
						reply:
							"Me conta um pouco mais: hoje, como você está em relação a esse objetivo?",
					},
					user: ["eu posso falar com o consultor?"],
				},
			],
		});

		assert.ok(turn?.result.schedulingOffer, turn?.assistant);
		assert.equal(calendarCalls.count, 1);
	} finally {
		await cleanupConversationFixture(fixture.leadId);
	}
});

// RC4 — the consultant offer is a backend constant.
test("RC4: com o motivo conhecido, a oferta usa exatamente CONSULTANT_OFFER_TEXT", async () => {
	const fixture = await createConversationFixture({ name: "Davi" });

	try {
		await seedHistory(fixture.conversationId, [
			{ content: "oi", role: "user" },
			{
				content: "Olá, Davi! Eu sou a Mariana. Qual o motivo do seu contato?",
				role: "assistant",
			},
		]);

		const [turn] = await runScriptedConversation({
			leadId: fixture.leadId,
			schedulingAvailabilityService: buildFakeAvailabilityService({ count: 0 }),
			turns: [
				{
					gemini: {
						leadUpdate: {
							consortiumType: "veículo",
							objective: "comprar um carro novo",
							status: "qualifying",
						},
						nextAction: "offer_meeting",
						reply:
							"Ótimo! Você gostaria de conversar com um consultor especializado?",
					},
					user: ["quero comprar um carro novo"],
				},
			],
		});

		assert.ok(turn?.assistant.endsWith(OFFER_TEXT), turn?.assistant);
	} finally {
		await cleanupConversationFixture(fixture.leadId);
	}
});

// RC5 — one message can fill several fields.
test("RC5: 'tenho um carro usado e quero um novo' preenche currentSituation e objective", async () => {
	const fixture = await createConversationFixture({ name: "Davi" });

	try {
		await seedHistory(fixture.conversationId, [
			{ content: "oi", role: "user" },
			{
				content: "Olá, Davi! Eu sou a Mariana. Qual o motivo do seu contato?",
				role: "assistant",
			},
		]);

		await runScriptedConversation({
			leadId: fixture.leadId,
			schedulingAvailabilityService: buildFakeAvailabilityService({ count: 0 }),
			turns: [
				{
					gemini: {
						leadUpdate: {
							objective: "comprar um carro novo",
							painPoint: "tem um carro usado",
							status: "qualifying",
						},
						reply: "Entendi!",
					},
					user: ["tenho um carro usado e quero um novo"],
				},
			],
		});

		const lead = await loadLead(fixture.leadId);
		assert.equal(lead.objective, "comprar um carro novo");
		assert.ok(lead.currentSituation, "currentSituation should be filled");
		assert.equal(lead.consortiumType, "veículo");
	} finally {
		await cleanupConversationFixture(fixture.leadId);
	}
});
