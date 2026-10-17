/** biome-ignore-all lint/performance/useTopLevelRegex: <> */
import assert from "node:assert/strict";
import test from "node:test";

import {
	COMMERCIAL_HANDOFF,
	CONSULTANT_OFFER_TEXT,
} from "../../ai/knowledge/commercial-policy";
import {
	composeStageReply,
	computeConversationStage,
	findAskedQuestion,
	inferConsortiumType,
	isAlreadySaidComplaint,
	isNameKnown,
	reconcileLeadUpdate,
	type StageLead,
} from "../../services/conversations/conversation-stage";
import {
	CONSULTANT_REASON_QUESTION,
	CURRENT_SITUATION_QUESTION,
	NAME_QUESTION,
	NEUTRAL_FALLBACK_REPLIES,
	PAIN_POINT_QUESTION,
	REASON_QUESTION,
} from "../../services/leads/qualification-gaps";

const PHONE = "5511999990000";

function lead(overrides: Partial<StageLead> = {}): StageLead {
	return {
		currentSituation: null,
		interestedInConsultant: false,
		name: "Davi",
		objective: null,
		painPoint: null,
		phone: PHONE,
		status: "qualifying",
		...overrides,
	};
}

function stage(
	leadOverrides: Partial<StageLead>,
	assistantHistory: string[] = ["Olá!"],
	hasActiveSchedulingSession = false
) {
	return computeConversationStage({
		assistantHistory,
		hasActiveSchedulingSession,
		lead: lead(leadOverrides),
	});
}

test("CONSULTANT_OFFER_TEXT é a pergunta fixa e o handoff termina com ela", () => {
	assert.equal(
		CONSULTANT_OFFER_TEXT,
		"Você quer que eu procure um horário para conversar com um consultor?"
	);
	assert.ok(COMMERCIAL_HANDOFF.endsWith(CONSULTANT_OFFER_TEXT));
});

test("nome vem do perfil do WhatsApp; telefone ou vazio não contam como nome", () => {
	assert.equal(isNameKnown("Davi", PHONE), true);
	assert.equal(isNameKnown(PHONE, PHONE), false);
	assert.equal(isNameKnown("  ", PHONE), false);
	assert.equal(isNameKnown("+55 11 99999-0000", PHONE), false);
});

test("primeiro contato é saudação e já carrega a próxima pergunta", () => {
	const withName = stage({}, []);
	assert.equal(withName.stage, "greeting");
	assert.equal(withName.question, REASON_QUESTION);

	const withoutName = stage({ name: PHONE }, []);
	assert.equal(withoutName.stage, "greeting");
	assert.equal(withoutName.question, NAME_QUESTION);
});

test("nome desconhecido é perguntado uma única vez", () => {
	assert.equal(stage({ name: PHONE }).question, NAME_QUESTION);

	const afterAsk = stage({ name: PHONE }, [`Olá! ${NAME_QUESTION}`]);
	assert.equal(afterAsk.stage, "reason");
	assert.equal(afterAsk.question, REASON_QUESTION);
});

test("motivo desconhecido é perguntado uma única vez", () => {
	assert.equal(stage({}).question, REASON_QUESTION);

	const afterAsk = stage({}, [REASON_QUESTION]);
	assert.equal(afterAsk.stage, "info");
	assert.equal(afterAsk.question, null);
});

test("motivo conhecido leva direto à oferta do consultor", () => {
	const plan = stage({ objective: "comprar um carro novo" });
	assert.equal(plan.stage, "consultant_offer");
	assert.equal(plan.question, CONSULTANT_OFFER_TEXT);
});

test("oferta já feita não se repete; opcionais são perguntados uma vez cada", () => {
	const objective = "comprar um carro novo";
	const offered = [`Entendi! ${CONSULTANT_OFFER_TEXT}`];

	assert.equal(
		stage({ objective }, offered).question,
		CURRENT_SITUATION_QUESTION
	);
	assert.equal(
		stage({ objective }, [...offered, CURRENT_SITUATION_QUESTION]).question,
		PAIN_POINT_QUESTION
	);
	assert.equal(
		stage({ currentSituation: "tem carro usado", objective }, offered).question,
		PAIN_POINT_QUESTION
	);
	const exhausted = stage({ objective }, [
		...offered,
		CURRENT_SITUATION_QUESTION,
		PAIN_POINT_QUESTION,
	]);
	assert.equal(exhausted.stage, "info");
	assert.equal(exhausted.question, null);
});

test("pedido de consultor sem motivo pergunta o motivo uma vez, antes do nome", () => {
	const plan = stage({ interestedInConsultant: true, name: PHONE });
	assert.equal(plan.stage, "reason");
	assert.equal(plan.question, CONSULTANT_REASON_QUESTION);

	assert.notEqual(
		stage({ interestedInConsultant: true }, [CONSULTANT_REASON_QUESTION])
			.question,
		CONSULTANT_REASON_QUESTION
	);
});

test("interesse confirmado com motivo conhecido é etapa de agendamento sem pergunta", () => {
	const plan = stage({
		interestedInConsultant: true,
		objective: "comprar um carro novo",
		status: "qualified",
	});
	assert.equal(plan.stage, "scheduling");
	assert.equal(plan.question, null);
});

test("sessão de agendamento ativa e lead agendado não recebem perguntas", () => {
	assert.equal(stage({}, ["Olá!"], true).stage, "scheduling");
	assert.equal(stage({}, ["Olá!"], true).question, null);
	assert.equal(stage({ status: "scheduled" }).stage, "confirmation");
	assert.equal(stage({ status: "scheduled" }).question, null);
});

test("doNotAsk lista campos conhecidos e perguntas já feitas", () => {
	const plan = stage({ objective: "comprar um carro novo" }, [REASON_QUESTION]);
	assert.ok(
		plan.doNotAsk.some((item) => item.includes("comprar um carro novo"))
	);
	assert.ok(plan.doNotAsk.some((item) => item.includes("Davi")));
});

test("textos antigos do backend contam como perguntas já feitas", () => {
	assert.equal(
		findAskedQuestion(
			"Para eu te orientar melhor, qual é o seu principal objetivo com o consórcio?"
		),
		"reason"
	);
	assert.equal(
		findAskedQuestion(
			"Me conta um pouco mais: hoje, como você está em relação a esse objetivo?"
		),
		"currentSituation"
	);
	assert.equal(findAskedQuestion(COMMERCIAL_HANDOFF), "consultantOffer");
	assert.equal(findAskedQuestion("Texto livre do Gemini?"), null);
});

test("tipo de consórcio é inferido do objetivo", () => {
	assert.equal(inferConsortiumType("comprar um carro novo"), "veículo");
	assert.equal(inferConsortiumType("quero uma moto"), "veículo");
	assert.equal(inferConsortiumType("comprar um apartamento"), "imóvel");
	assert.equal(inferConsortiumType("fazer uma reforma"), "serviços");
	assert.equal(inferConsortiumType("não sei ainda"), undefined);
});

test("reconcile remove status e interesse decididos pelo Gemini", () => {
	const reconciled = reconcileLeadUpdate({
		currentMessages: ["oi"],
		lastAskedQuestion: null,
		lead: lead(),
		leadUpdate: { interestedInConsultant: true, status: "qualified" },
	});
	assert.equal("status" in reconciled, false);
	assert.equal("interestedInConsultant" in reconciled, false);
});

test("reconcile preenche situação atual e objetivo de uma única mensagem", () => {
	const reconciled = reconcileLeadUpdate({
		currentMessages: ["tenho um carro usado e quero um novo"],
		lastAskedQuestion: "reason",
		lead: lead(),
		leadUpdate: {
			objective: "comprar um carro novo",
			painPoint: "tem um carro usado",
			status: "qualifying",
		},
	});
	assert.equal(reconciled.objective, "comprar um carro novo");
	assert.equal(reconciled.currentSituation, "tem um carro usado");
	assert.equal(reconciled.painPoint, undefined);
	assert.equal(reconciled.consortiumType, "veículo");
});

test("reconcile mantém painPoint quando o texto é motivação", () => {
	const reconciled = reconcileLeadUpdate({
		currentMessages: ["necessidade"],
		lastAskedQuestion: "painPoint",
		lead: lead({ objective: "comprar um carro novo" }),
		leadUpdate: { painPoint: "necessidade", status: "qualifying" },
	});
	assert.equal(reconciled.painPoint, "necessidade");
	assert.equal(reconciled.currentSituation, undefined);
});

test("reconcile usa a resposta ao motivo quando o Gemini não extraiu o objetivo", () => {
	const reconciled = reconcileLeadUpdate({
		currentMessages: ["um apartamento"],
		lastAskedQuestion: "consultantReason",
		lead: lead(),
		leadUpdate: { status: "qualifying" },
	});
	assert.equal(reconciled.objective, "um apartamento");
	assert.equal(reconciled.consortiumType, "imóvel");
});

test("reconcile aceita nome só quando o nome atual é desconhecido", () => {
	assert.equal(
		reconcileLeadUpdate({
			currentMessages: ["Davi"],
			lastAskedQuestion: "name",
			lead: lead({ name: PHONE }),
			leadUpdate: { name: "Davi", status: "qualifying" },
		}).name,
		"Davi"
	);
	assert.equal(
		reconcileLeadUpdate({
			currentMessages: ["me chama de Zé"],
			lastAskedQuestion: null,
			lead: lead(),
			leadUpdate: { name: "Zé", status: "qualifying" },
		}).name,
		undefined
	);
	assert.equal(
		reconcileLeadUpdate({
			currentMessages: ["meu nome é Ana Paula"],
			lastAskedQuestion: "name",
			lead: lead({ name: PHONE }),
			leadUpdate: { status: "qualifying" },
		}).name,
		"Ana Paula"
	);
});

test("já disse isso é reconhecido", () => {
	assert.equal(isAlreadySaidComplaint(["eu ja disse isso"]), true);
	assert.equal(isAlreadySaidComplaint(["Já falei!"]), true);
	assert.equal(isAlreadySaidComplaint(["eu já te respondi"]), true);
	assert.equal(isAlreadySaidComplaint(["veiculo"]), false);
});

test("compose remove perguntas do Gemini e acrescenta a pergunta do backend", () => {
	const reply = composeStageReply({
		apologize: false,
		isFirstContact: false,
		modelReply:
			"Entendi, Davi! Qual é a sua situação atual em relação a esse objetivo?",
		previousAssistantMessage: null,
		question: CONSULTANT_OFFER_TEXT,
	});
	assert.equal(reply, `Entendi, Davi! ${CONSULTANT_OFFER_TEXT}`);
});

test("compose não repete cumprimento fora do primeiro contato", () => {
	const reply = composeStageReply({
		apologize: false,
		isFirstContact: false,
		modelReply: "Olá de novo, Davi! Boa noite! Entendi o seu objetivo.",
		previousAssistantMessage: null,
		question: null,
	});
	assert.equal(reply, "Entendi o seu objetivo.");

	const first = composeStageReply({
		apologize: false,
		isFirstContact: true,
		modelReply: "Olá, Davi! Eu sou a Mariana.",
		previousAssistantMessage: null,
		question: REASON_QUESTION,
	});
	assert.equal(first, `Olá, Davi! Eu sou a Mariana. ${REASON_QUESTION}`);
});

test("compose limita a 3 frases e 1 pergunta", () => {
	const reply = composeStageReply({
		apologize: false,
		isFirstContact: true,
		modelReply:
			"Olá, Davi! Boa noite! Eu sou a Mariana. O consórcio é uma compra planejada. Você sabia?",
		previousAssistantMessage: null,
		question: REASON_QUESTION,
	});
	assert.equal(reply, `Olá, Davi! Boa noite! ${REASON_QUESTION}`);
	assert.equal(reply.split("?").length - 1, 1);
});

test("compose pede desculpa uma vez quando o cliente diz que já respondeu", () => {
	assert.equal(
		composeStageReply({
			apologize: true,
			isFirstContact: false,
			modelReply: "Entendi.",
			previousAssistantMessage: null,
			question: CONSULTANT_OFFER_TEXT,
		}),
		`Desculpe! Entendi. ${CONSULTANT_OFFER_TEXT}`
	);
	assert.equal(
		composeStageReply({
			apologize: true,
			isFirstContact: false,
			modelReply: "Desculpe, você já tinha dito.",
			previousAssistantMessage: null,
			question: CONSULTANT_OFFER_TEXT,
		}),
		`Desculpe, você já tinha dito. ${CONSULTANT_OFFER_TEXT}`
	);
});

test("compose sem conteúdo usa uma frase neutra que não repete a anterior", () => {
	const [first, second] = NEUTRAL_FALLBACK_REPLIES;
	const reply = composeStageReply({
		apologize: false,
		isFirstContact: false,
		modelReply: "Você gostaria de conversar com um consultor?",
		previousAssistantMessage: null,
		question: null,
	});
	assert.equal(reply, first);
	assert.equal(
		composeStageReply({
			apologize: false,
			isFirstContact: false,
			modelReply: "Qual o tipo?",
			previousAssistantMessage: first,
			question: null,
		}),
		second
	);
	assert.equal(
		composeStageReply({
			apologize: true,
			isFirstContact: false,
			modelReply: "Desculpe!",
			previousAssistantMessage: first,
			question: null,
		}),
		`Desculpe! ${second}`
	);
});
