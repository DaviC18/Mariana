/** biome-ignore-all lint/style/useFilenamingConvention: <> */

import { CONSULTANT_OFFER_TEXT } from "../../ai/knowledge/commercial-policy";
import {
	CONSULTANT_REASON_QUESTION,
	LEGACY_QUESTION_TEXTS,
} from "../leads/qualification-gaps";

// Oferta enviada pelo backend na última mensagem da assistente. Vale somente
// para a próxima mensagem do cliente.
// - consultant_meeting: pergunta sim/não CONSULTANT_OFFER_TEXT (também no
//   final do COMMERCIAL_HANDOFF).
// - consultant_reason: o cliente pediu um consultor sem motivo conhecido e o
//   backend perguntou o motivo; respondê-lo autoriza a oferta neste turno.
export type PendingOffer = "consultant_meeting" | "consultant_reason";

const CONSULTANT_OFFER_MARKERS = [
	CONSULTANT_OFFER_TEXT,
	...LEGACY_QUESTION_TEXTS.consultantOffer,
];

// Marcador sem migração: texto exato do backend na mensagem anterior da
// assistente. Texto livre do modelo nunca conta.
export function detectPendingOffer(
	previousAssistantMessage: string | null | undefined
): PendingOffer | null {
	if (!previousAssistantMessage) {
		return null;
	}

	if (
		CONSULTANT_OFFER_MARKERS.some((marker) =>
			previousAssistantMessage.includes(marker)
		)
	) {
		return "consultant_meeting";
	}

	if (previousAssistantMessage.includes(CONSULTANT_REASON_QUESTION)) {
		return "consultant_reason";
	}

	return null;
}

const NEGATION_OR_DEFERRAL_PATTERN =
	/\b(?:nao|nunca|depois|talvez|mais tarde|outra hora|outro dia|agora nao|sei la|mas|porem|na verdade)\b/;

// Palavras que confirmam o aceite por si só.
const AFFIRMATIVE_CORE_TOKENS = new Set([
	"aceito",
	"aham",
	"beleza",
	"blz",
	"bora",
	"certeza",
	"claro",
	"gostaria",
	"isso",
	"manda",
	"ok",
	"okay",
	"otimo",
	"perfeito",
	"pode",
	"positivo",
	"quero",
	"s",
	"show",
	"sim",
	"uhum",
	"vamos",
]);

// Complementos aceitos ao lado de uma palavra de aceite.
const AFFIRMATIVE_FILLER_TOKENS = new Set([
	"agendar",
	"com",
	"consultor",
	"conversar",
	"eu",
	"favor",
	"horario",
	"horarios",
	"marcar",
	"o",
	"os",
	"pf",
	"pfv",
	"por",
	"porfavor",
	"ser",
	"um",
	"ver",
]);

function normalize(message: string): string {
	return message
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.trim();
}

// Aceite curto e inequívoco. Perguntas, negações, adiamentos ou qualquer
// conteúdo além do vocabulário de aceite não contam.
export function isClearAffirmative(message: string): boolean {
	const normalized = normalize(message);

	if (
		normalized.length === 0 ||
		normalized.includes("?") ||
		NEGATION_OR_DEFERRAL_PATTERN.test(normalized)
	) {
		return false;
	}

	const tokens = normalized
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.split(" ")
		.filter(Boolean);

	return (
		tokens.some((token) => AFFIRMATIVE_CORE_TOKENS.has(token)) &&
		tokens.every(
			(token) =>
				AFFIRMATIVE_CORE_TOKENS.has(token) ||
				AFFIRMATIVE_FILLER_TOKENS.has(token)
		)
	);
}

// A oferta só é aceita quando existe marcador pendente e todas as mensagens
// do bloco atual são afirmativas claras.
export function acceptsPendingOffer({
	currentMessages,
	pendingOffer,
}: {
	currentMessages: string[];
	pendingOffer: PendingOffer | null | undefined;
}): boolean {
	return (
		pendingOffer === "consultant_meeting" &&
		currentMessages.length > 0 &&
		currentMessages.every(isClearAffirmative)
	);
}
