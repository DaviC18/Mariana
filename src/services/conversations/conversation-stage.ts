/** biome-ignore-all lint/style/useFilenamingConvention: <> */
/** biome-ignore-all lint/performance/useTopLevelRegex: <> */

// Etapas da conversa calculadas pelo backend a partir do lead persistido e do
// histórico. O backend escolhe a única pergunta do turno; o Gemini só escreve
// o texto em volta dela. "Já perguntado" vem dos textos exatos do backend no
// histórico, sem migração.

import { CONSULTANT_OFFER_TEXT } from "../../ai/knowledge/commercial-policy";
import type { MarianaResponse } from "../../ai/schemas/mariana-response-schema";
import {
	CONSULTANT_REASON_QUESTION,
	CURRENT_SITUATION_QUESTION,
	LEGACY_QUESTION_TEXTS,
	NAME_QUESTION,
	NEUTRAL_FALLBACK_REPLIES,
	PAIN_POINT_QUESTION,
	REASON_QUESTION,
} from "../leads/qualification-gaps";

export type ConversationStage =
	| "greeting"
	| "name"
	| "reason"
	| "info"
	| "consultant_offer"
	| "scheduling"
	| "confirmation";

export type StageQuestionKey =
	| "name"
	| "reason"
	| "consultantReason"
	| "consultantOffer"
	| "currentSituation"
	| "painPoint";

export interface StageLead {
	currentSituation: string | null;
	interestedInConsultant: boolean | null;
	name: string;
	objective: string | null;
	painPoint: string | null;
	phone: string;
	status: string;
}

export interface StagePlan {
	askedQuestions: StageQuestionKey[];
	doNotAsk: string[];
	question: string | null;
	questionKey: StageQuestionKey | null;
	stage: ConversationStage;
}

const QUESTION_TEXTS: Record<StageQuestionKey, string> = {
	consultantOffer: CONSULTANT_OFFER_TEXT,
	consultantReason: CONSULTANT_REASON_QUESTION,
	currentSituation: CURRENT_SITUATION_QUESTION,
	name: NAME_QUESTION,
	painPoint: PAIN_POINT_QUESTION,
	reason: REASON_QUESTION,
};

// Ordem importa: CONSULTANT_OFFER_TEXT também aparece dentro do handoff.
const QUESTION_MARKERS: [StageQuestionKey, readonly string[]][] = [
	[
		"consultantOffer",
		[CONSULTANT_OFFER_TEXT, ...LEGACY_QUESTION_TEXTS.consultantOffer],
	],
	["consultantReason", [CONSULTANT_REASON_QUESTION]],
	["name", [NAME_QUESTION]],
	["reason", [REASON_QUESTION, ...LEGACY_QUESTION_TEXTS.reason]],
	[
		"currentSituation",
		[CURRENT_SITUATION_QUESTION, ...LEGACY_QUESTION_TEXTS.currentSituation],
	],
	["painPoint", [PAIN_POINT_QUESTION, ...LEGACY_QUESTION_TEXTS.painPoint]],
];

const QUESTION_DESCRIPTIONS: Record<StageQuestionKey, string> = {
	consultantOffer: "oferta de conversar com um consultor",
	consultantReason: "motivo do contato",
	currentSituation: "situação atual",
	name: "nome do cliente",
	painPoint: "motivação",
	reason: "motivo do contato / objetivo / tipo de consórcio",
};

function normalize(value: string): string {
	return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

function hasText(value: string | null | undefined): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

export function isNameKnown(name: string | null | undefined, phone: string) {
	if (!hasText(name)) {
		return false;
	}
	const trimmed = name.trim();
	return trimmed !== phone && !/^[\d\s()+-]+$/.test(trimmed);
}

// Pergunta do backend contida na mensagem, ou null para texto livre.
export function findAskedQuestion(message: string): StageQuestionKey | null {
	for (const [key, markers] of QUESTION_MARKERS) {
		if (markers.some((marker) => message.includes(marker))) {
			return key;
		}
	}
	return null;
}

export function getAskedQuestions(
	assistantHistory: readonly string[]
): Set<StageQuestionKey> {
	const asked = new Set<StageQuestionKey>();
	for (const message of assistantHistory) {
		const key = findAskedQuestion(message);
		if (key) {
			asked.add(key);
		}
	}
	return asked;
}

function nextQuestion(
	lead: StageLead,
	asked: Set<StageQuestionKey>
): { key: StageQuestionKey | null; stage: ConversationStage } {
	const objectiveKnown = hasText(lead.objective);

	// Pedido de consultor tem prioridade sobre qualquer pergunta pendente.
	if (lead.interestedInConsultant === true) {
		if (objectiveKnown) {
			return { key: null, stage: "scheduling" };
		}
		if (!asked.has("consultantReason")) {
			return { key: "consultantReason", stage: "reason" };
		}
	}

	if (!(isNameKnown(lead.name, lead.phone) || asked.has("name"))) {
		return { key: "name", stage: "name" };
	}

	if (!objectiveKnown) {
		return asked.has("reason") || asked.has("consultantReason")
			? { key: null, stage: "info" }
			: { key: "reason", stage: "reason" };
	}

	if (!asked.has("consultantOffer")) {
		return { key: "consultantOffer", stage: "consultant_offer" };
	}

	if (!(hasText(lead.currentSituation) || asked.has("currentSituation"))) {
		return { key: "currentSituation", stage: "info" };
	}

	if (!(hasText(lead.painPoint) || asked.has("painPoint"))) {
		return { key: "painPoint", stage: "info" };
	}

	return { key: null, stage: "info" };
}

function buildDoNotAsk(
	lead: StageLead,
	asked: Set<StageQuestionKey>
): string[] {
	const known: string[] = [];
	if (isNameKnown(lead.name, lead.phone)) {
		known.push(`nome: ${lead.name}`);
	}
	if (hasText(lead.objective)) {
		known.push(
			`objetivo e tipo de consórcio: ${lead.objective} (não pergunte o tipo)`
		);
	}
	if (hasText(lead.currentSituation)) {
		known.push(`situação atual: ${lead.currentSituation}`);
	}
	if (hasText(lead.painPoint)) {
		known.push(`motivação: ${lead.painPoint}`);
	}
	for (const key of asked) {
		known.push(`já perguntado: ${QUESTION_DESCRIPTIONS[key]}`);
	}
	return known;
}

export function computeConversationStage({
	assistantHistory,
	hasActiveSchedulingSession,
	lead,
}: {
	assistantHistory: readonly string[];
	hasActiveSchedulingSession: boolean;
	lead: StageLead;
}): StagePlan {
	const asked = getAskedQuestions(assistantHistory);
	const base = {
		askedQuestions: [...asked],
		doNotAsk: buildDoNotAsk(lead, asked),
	};

	if (lead.status === "scheduled") {
		return {
			...base,
			question: null,
			questionKey: null,
			stage: "confirmation",
		};
	}

	if (hasActiveSchedulingSession) {
		return { ...base, question: null, questionKey: null, stage: "scheduling" };
	}

	const next = nextQuestion(lead, asked);
	const stage = assistantHistory.length === 0 ? "greeting" : next.stage;

	return {
		...base,
		question: next.key ? QUESTION_TEXTS[next.key] : null,
		questionKey: next.key,
		stage,
	};
}

const VEHICLE_PATTERN =
	/\b(?:carros?|veiculos?|motos?|motocicletas?|caminhao|caminhoes|caminhonetes?|automove(?:l|is)|onibus|van|suv|picape)\b/;
const PROPERTY_PATTERN =
	/\b(?:casas?|apartamentos?|apto|imove(?:l|is)|terrenos?|lotes?|sobrados?|chacaras?|sitios?|salas? comerciais?)\b/;
const SERVICES_PATTERN =
	/\b(?:servicos?|reformas?|viagens?|cirurgias?|casamentos?|festas?|estudos?|faculdade|intercambio|tratamentos?)\b/;

export function inferConsortiumType(text: string | null | undefined) {
	if (!hasText(text)) {
		return;
	}
	const normalized = normalize(text);
	if (VEHICLE_PATTERN.test(normalized)) {
		return "veículo";
	}
	if (PROPERTY_PATTERN.test(normalized)) {
		return "imóvel";
	}
	if (SERVICES_PATTERN.test(normalized)) {
		return "serviços";
	}
}

// Texto que descreve o que o cliente tem ou vive hoje, não por que quer.
const CURRENT_SITUATION_PATTERN =
	/\b(?:ja tenho|tenho (?:um|uma)|nao tenho|moro|pago aluguel|de aluguel|uso (?:uber|aplicativo|onibus|transporte)|ando de|meu carro (?:e|esta)|hoje eu)\b/;

const NAME_PREFIX_PATTERN =
	/^(?:(?:o\s+)?meu nome e|me chamo|pode me chamar de|eu sou (?:o|a)|sou (?:o|a))\s+/;

function extractNameAnswer(message: string): string | undefined {
	const trimmed = message
		.normalize("NFC")
		.trim()
		.replace(/[.!]+$/, "");
	// normalize() preserva o tamanho de texto NFC, então o prefixo achado sem
	// acentos ("meu nome e") corta o original ("meu nome é") no mesmo ponto.
	const prefixLength =
		normalize(trimmed).match(NAME_PREFIX_PATTERN)?.[0].length ?? 0;
	const candidate = trimmed.slice(prefixLength).trim();
	const words = candidate.split(/\s+/).filter(Boolean);
	if (
		words.length === 0 ||
		words.length > 4 ||
		!words.every((word) => /^\p{L}[\p{L}'-]*$/u.test(word))
	) {
		return undefined;
	}
	return words
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

type LeadUpdate = MarianaResponse["leadUpdate"] & { name?: string | null };

export type ReconciledLeadUpdate = Omit<
	LeadUpdate,
	"interestedInConsultant" | "status"
>;

// Valida a extração do Gemini contra o que o backend sabe: status e interesse
// são do backend; o tipo vem do objetivo; situação atual não vira motivação;
// a resposta à pergunta de motivo/nome é aproveitada quando o modelo falha.
export function reconcileLeadUpdate({
	currentMessages,
	lastAskedQuestion,
	lead,
	leadUpdate,
}: {
	currentMessages: readonly string[];
	lastAskedQuestion: StageQuestionKey | null;
	lead: StageLead;
	leadUpdate: LeadUpdate;
}): ReconciledLeadUpdate {
	const {
		interestedInConsultant: _interested,
		status: _status,
		...reconciled
	} = leadUpdate;
	const userText = currentMessages.join("\n");
	const normalizedUserText = normalize(userText);

	if (
		!(hasText(reconciled.objective) || hasText(lead.objective)) &&
		(lastAskedQuestion === "reason" ||
			lastAskedQuestion === "consultantReason") &&
		inferConsortiumType(userText)
	) {
		reconciled.objective = userText.trim().slice(0, 200);
	}

	if (!hasText(reconciled.consortiumType)) {
		const inferred = inferConsortiumType(
			reconciled.objective ?? lead.objective
		);
		if (inferred && hasText(reconciled.objective)) {
			reconciled.consortiumType = inferred;
		}
	}

	if (
		hasText(reconciled.painPoint) &&
		!hasText(reconciled.currentSituation) &&
		!hasText(lead.currentSituation) &&
		(lastAskedQuestion === "currentSituation" ||
			CURRENT_SITUATION_PATTERN.test(normalizedUserText))
	) {
		reconciled.currentSituation = reconciled.painPoint;
		reconciled.painPoint = undefined;
	}

	if (isNameKnown(lead.name, lead.phone)) {
		reconciled.name = undefined;
	} else if (!hasText(reconciled.name) && lastAskedQuestion === "name") {
		reconciled.name =
			currentMessages.length === 1
				? extractNameAnswer(currentMessages[0] ?? "")
				: undefined;
	}

	return reconciled;
}

const ALREADY_SAID_PATTERN =
	/\b(?:ja|eu ja)\s+(?:te\s+|lhe\s+)?(?:disse|falei|respondi|informei|expliquei|contei|mandei)\b/;

export function isAlreadySaidComplaint(currentMessages: readonly string[]) {
	return currentMessages.some((message) =>
		ALREADY_SAID_PATTERN.test(normalize(message))
	);
}

const GREETING_SENTENCE_PATTERN =
	/^(?:ola|oi|opa|bom dia|boa tarde|boa noite)\b[^.!?]{0,40}[.!?]?$/;
const APOLOGY_PATTERN = /\bdesculp/;
const APOLOGY = "Desculpe!";
const MAX_SENTENCES = 3;

export function splitSentences(text: string): string[] {
	return text
		.split(/(?<=[.!?])\s+|\n+/)
		.map((sentence) => sentence.trim())
		.filter((sentence) => /[\p{L}\p{N}]/u.test(sentence));
}

// Monta a resposta final: frases do Gemini sem perguntas e sem cumprimento
// repetido, no máximo 3 frases no total, e a pergunta do backend no fim.
export function composeStageReply({
	apologize,
	isFirstContact,
	modelReply,
	previousAssistantMessage,
	question,
}: {
	apologize: boolean;
	isFirstContact: boolean;
	modelReply: string;
	previousAssistantMessage: string | null | undefined;
	question: string | null;
}): string {
	let statements = splitSentences(modelReply).filter(
		(sentence) =>
			!sentence.endsWith("?") &&
			(isFirstContact || !GREETING_SENTENCE_PATTERN.test(normalize(sentence)))
	);

	if (
		apologize &&
		!statements.some((sentence) => APOLOGY_PATTERN.test(normalize(sentence)))
	) {
		statements = [APOLOGY, ...statements];
	}

	const onlyApology =
		statements.length > 0 &&
		statements.every((sentence) => APOLOGY_PATTERN.test(normalize(sentence)));

	if (!question && (statements.length === 0 || onlyApology)) {
		const [first, second] = NEUTRAL_FALLBACK_REPLIES;
		statements = [
			...statements,
			previousAssistantMessage?.includes(first) ? second : first,
		];
	}

	const maxStatements = question ? MAX_SENTENCES - 1 : MAX_SENTENCES;
	return [
		...statements.slice(0, maxStatements),
		...(question ? [question] : []),
	]
		.join(" ")
		.trim();
}
