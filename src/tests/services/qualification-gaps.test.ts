/** biome-ignore-all lint/performance/useTopLevelRegex: <> */
import assert from "node:assert/strict";
import test from "node:test";

import { CONSULTANT_OFFER_TEXT } from "../../ai/knowledge/commercial-policy";
import { isLeadQualified } from "../../services/leads/lead-qualification";
import {
	CONSULTANT_REASON_QUESTION,
	CURRENT_SITUATION_QUESTION,
	describeQualificationFields,
	getMissingQualificationFields,
	mergeQualificationInput,
	NAME_QUESTION,
	PAIN_POINT_QUESTION,
	QUALIFICATION_FIELDS,
	REASON_QUESTION,
} from "../../services/leads/qualification-gaps";

const QUALIFIED_LEAD = {
	interestedInConsultant: true,
	objective: "Comprar um carro novo",
};

test("lead vazio retorna os campos obrigatórios: objetivo e interesse", () => {
	assert.deepEqual(getMissingQualificationFields({}), [
		"objective",
		"interestedInConsultant",
	]);
	assert.deepEqual(getMissingQualificationFields({}), [
		...QUALIFICATION_FIELDS,
	]);
});

test("lead qualificado não tem pendências e espelha isLeadQualified", () => {
	assert.deepEqual(getMissingQualificationFields(QUALIFIED_LEAD), []);
	assert.equal(isLeadQualified(QUALIFIED_LEAD), true);
});

test("situação atual, motivação e tipo nunca são pendências obrigatórias", () => {
	assert.deepEqual(
		getMissingQualificationFields({
			consortiumType: null,
			currentSituation: null,
			interestedInConsultant: true,
			objective: "Comprar um carro",
			painPoint: null,
		}),
		[]
	);
});

test("interesse no consultor exige true explícito, como isLeadQualified", () => {
	for (const interestedInConsultant of [false, null, undefined, "false"]) {
		const lead = { ...QUALIFIED_LEAD, interestedInConsultant };
		assert.deepEqual(getMissingQualificationFields(lead), [
			"interestedInConsultant",
		]);
		assert.equal(isLeadQualified(lead), false);
	}
});

test("pendências vazias equivalem a isLeadQualified sem birthDate", () => {
	for (const lead of [
		{},
		{ objective: "Comprar um carro" },
		{ interestedInConsultant: true },
		QUALIFIED_LEAD,
	]) {
		assert.equal(
			getMissingQualificationFields(lead).length === 0,
			isLeadQualified(lead)
		);
	}
});

test("descrições em pt-BR acompanham os campos na ordem recebida", () => {
	const descriptions = describeQualificationFields([
		"interestedInConsultant",
		"objective",
	]);

	assert.equal(descriptions.length, 2);
	assert.match(descriptions[0] ?? "", /consultor/i);
	assert.match(descriptions[1] ?? "", /objetivo/i);
	assert.deepEqual(describeQualificationFields([]), []);
});

test("perguntas de etapa são distintas e têm exatamente uma pergunta", () => {
	const questions = [
		NAME_QUESTION,
		REASON_QUESTION,
		CONSULTANT_REASON_QUESTION,
		CURRENT_SITUATION_QUESTION,
		PAIN_POINT_QUESTION,
		CONSULTANT_OFFER_TEXT,
	];
	assert.equal(new Set(questions).size, questions.length);
	for (const question of questions) {
		assert.ok(question.endsWith("?"), question);
		assert.equal(question.split("?").length - 1, 1, question);
	}
});

test("merge aplica apenas valores não nulos do leadUpdate", () => {
	const merged = mergeQualificationInput(
		{
			consortiumType: "veículo",
			objective: "Comprar um carro",
			painPoint: null,
		},
		{
			consortiumType: null,
			currentSituation: "Não tenho carro",
			objective: undefined,
			status: "qualifying",
		}
	);

	assert.equal(merged.consortiumType, "veículo");
	assert.equal(merged.objective, "Comprar um carro");
	assert.equal(merged.currentSituation, "Não tenho carro");
	assert.deepEqual(getMissingQualificationFields(merged), [
		"interestedInConsultant",
	]);
});
