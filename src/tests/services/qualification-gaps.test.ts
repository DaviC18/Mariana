/** biome-ignore-all lint/performance/useTopLevelRegex: <> */
import assert from "node:assert/strict";
import test from "node:test";

import { isLeadQualified } from "../../services/leads/lead-qualification";
import {
	buildQualificationFallbackReply,
	DEFAULT_FALLBACK_REPLY,
	describeQualificationFields,
	getMissingQualificationFields,
	mergeQualificationInput,
	QUALIFICATION_FIELDS,
} from "../../services/leads/qualification-gaps";

const QUALIFIED_LEAD = {
	consortiumType: "veículo",
	currentSituation: "Ainda não tenho carro",
	interestedInConsultant: true,
	objective: "Comprar um carro novo",
	painPoint: "Quero sair do transporte por aplicativo",
};

test("lead vazio retorna todos os campos na ordem de qualificação", () => {
	assert.deepEqual(getMissingQualificationFields({}), [
		"objective",
		"consortiumType",
		"currentSituation",
		"painPoint",
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

test("strings em branco contam como ausentes", () => {
	assert.deepEqual(
		getMissingQualificationFields({
			...QUALIFIED_LEAD,
			consortiumType: "   ",
			objective: "",
		}),
		["objective", "consortiumType"]
	);
});

test("motivation satisfaz painPoint", () => {
	assert.deepEqual(
		getMissingQualificationFields({
			...QUALIFIED_LEAD,
			motivation: "Quero independência",
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
	assert.deepEqual(
		getMissingQualificationFields({
			...QUALIFIED_LEAD,
			interestedInConsultant: "true",
		}),
		[]
	);
});

test("pendências vazias equivalem a isLeadQualified sem birthDate", () => {
	const variants = [
		{},
		QUALIFIED_LEAD,
		{ ...QUALIFIED_LEAD, currentSituation: " " },
		{ ...QUALIFIED_LEAD, painPoint: undefined },
		{ ...QUALIFIED_LEAD, motivation: "x", painPoint: undefined },
		{ consortiumType: "veículo", objective: "carro" },
	];

	for (const lead of variants) {
		assert.equal(
			getMissingQualificationFields(lead).length === 0,
			isLeadQualified(lead)
		);
	}
});

test("descrições em pt-BR acompanham os campos na ordem recebida", () => {
	const descriptions = describeQualificationFields([
		"currentSituation",
		"objective",
	]);

	assert.equal(descriptions.length, 2);
	assert.match(descriptions[0] ?? "", /situação atual/i);
	assert.match(descriptions[1] ?? "", /objetivo/i);
	assert.deepEqual(describeQualificationFields([]), []);
});

test("fallback pergunta somente sobre o primeiro campo pendente e termina com ?", () => {
	for (const field of QUALIFICATION_FIELDS) {
		const reply = buildQualificationFallbackReply([field]);
		assert.ok(reply.endsWith("?"), `${field}: ${reply}`);
		assert.equal(reply.split("?").length - 1, 1, `${field}: ${reply}`);
	}

	assert.equal(
		buildQualificationFallbackReply(["currentSituation", "painPoint"]),
		buildQualificationFallbackReply(["currentSituation"])
	);
	assert.notEqual(
		buildQualificationFallbackReply(["objective"]),
		buildQualificationFallbackReply(["consortiumType"])
	);
});

test("fallback sem pendências usa a pergunta genérica", () => {
	assert.equal(buildQualificationFallbackReply([]), DEFAULT_FALLBACK_REPLY);
	assert.ok(DEFAULT_FALLBACK_REPLY.endsWith("?"));
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
		"painPoint",
		"interestedInConsultant",
	]);
});
