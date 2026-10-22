import { createHash } from "node:crypto";

/**
 * As doze camadas de reescrita do turno (a auditoria numera a partir de L0).
 * Uma camada que rodou e não mudou o texto não gera registro.
 */
export type RewriteLayer =
	| "L0_level3_short_circuit"
	| "L1_identity_sanitizer"
	| "L2_evidence_invalid_id"
	| "L3_evidence_handoff"
	| "L4_safety_assertion"
	| "L5_request_consultant_override"
	| "L6_dropped_questions"
	| "L7_dropped_greeting"
	| "L8_sentence_cap"
	| "L9_neutral_fallback"
	| "L10_unauthorized_scheduling"
	| "L11_slot_offer_replaced";

export interface RewriteRecord {
	detail?: Record<string, number | string>;
	hashAfter: string;
	hashBefore: string;
	layer: RewriteLayer;
	lengthAfter: number;
	lengthBefore: number;
}

/**
 * `turn_error` (decisão P-4) cobre um lançamento que não é falha de modelo nem
 * guardrail — falha de calendário, de banco ou da transação. O turno continua
 * falhando como antes; só deixa de ser silencioso.
 */
export type TurnOutcome =
	| "replied"
	| "model_error"
	| "guardrail_throw"
	| "turn_error";

export interface TurnTraceUsage {
	candidatesTokens: number | null;
	promptTokens: number | null;
	thoughtsTokens: number | null;
	totalTokens: number | null;
}

/**
 * Um turno, em uma linha. Regra de privacidade mecânica: nenhum campo aqui
 * tem tipo que aceite texto livre do cliente ou do modelo — todo texto já
 * chega reduzido a comprimento (`number`) e hash de 12 hex (`hashText`), e o
 * telefone nunca entra, só o `leadId`. Acrescentar um campo de texto exige
 * mudar este tipo, o que a revisão enxerga.
 */
export interface TurnTrace {
	actionBlockedReason: string | null;
	/** `null` quando o produtor não reportou o nível. */
	commercialAccessLevel: 1 | 2 | 3 | null;
	conversationId: string;
	executedAction: string;
	finishReason: string | null;
	/**
	 * Id da camada que lançou (L2 ou L4), `null` em qualquer outro desfecho —
	 * decisão P-1: "lançou um guardrail" não diz *qual*.
	 */
	guardrailLayer: RewriteLayer | null;
	/** `null` quando nenhuma chamada ao modelo foi medida. */
	latencyMs: number | null;
	leadId: string;
	maxOutputTokens: number;
	model: string;
	modelVersionReturned: string | null;
	outcome: TurnOutcome;
	postTurnStage: string;
	/** `null` quando `rewrites` não foi reportado: a afirmação é indecidível. */
	pureBackendText: boolean | null;
	questionKey: string | null;
	/** `null` num desfecho em que nenhuma resposta do modelo chegou. */
	rawReplyHash: string | null;
	rawReplyLength: number | null;
	requestedNextAction: string;
	/**
	 * `null`, nunca `[]`, quando o produtor não reportou (decisão P-2):
	 * "nenhuma camada reescreveu" e "ninguém nos contou" são afirmações
	 * diferentes, e a primeira é a mais importante do rastro.
	 */
	rewrites: RewriteRecord[] | null;
	rewritesReported: boolean;
	/** `null` quando nada foi enviada ao cliente (ex.: guardrail lançou). */
	sentReplyHash: string | null;
	sentReplyLength: number | null;
	stage: string;
	temperature: number;
	thinkingLevel: string;
	turnId: string;
	usage: TurnTraceUsage;
}

const HASH_LENGTH = 12;
const SENTENCE_SPLIT = /[.!?]+/;
const WHITESPACE_RUN = /\s+/g;

/**
 * As camadas que substituem o texto do modelo por texto do backend, em vez de
 * apenas podá-lo.
 */
const BACKEND_AUTHORED_LAYERS = new Set<RewriteLayer>([
	"L0_level3_short_circuit",
	"L3_evidence_handoff",
	"L5_request_consultant_override",
	"L9_neutral_fallback",
	"L10_unauthorized_scheduling",
	"L11_slot_offer_replaced",
]);

/**
 * SHA-256 hex, 12 caracteres (48 bits). Só respostas da própria Mariana são
 * hasheadas — nunca as palavras do cliente.
 */
export function hashText(text: string): string {
	return createHash("sha256")
		.update(text, "utf8")
		.digest("hex")
		.slice(0, HASH_LENGTH);
}

/**
 * O único construtor de registros (decisão P-3 do plano): toda camada, em
 * qualquer produtor, descreve a transição como duas strings. Assim o
 * `hashBefore` de um registro é sempre o `hashAfter` do anterior, e o do
 * primeiro é o hash da resposta crua.
 */
export function buildRewriteRecord(
	layer: RewriteLayer,
	before: string,
	after: string,
	detail?: RewriteRecord["detail"]
): RewriteRecord {
	return {
		...(detail === undefined ? {} : { detail }),
		hashAfter: hashText(after),
		hashBefore: hashText(before),
		layer,
		lengthAfter: after.length,
		lengthBefore: before.length,
	};
}

function toSentences(text: string): string[] {
	return text
		.split(SENTENCE_SPLIT)
		.map((sentence) => sentence.replace(WHITESPACE_RUN, " ").trim())
		.filter((sentence) => sentence.length > 0);
}

/**
 * `true` quando nenhuma frase do modelo sobreviveu: alguma camada de texto do
 * backend atuou **e** o texto final não compartilha nenhuma frase com a
 * resposta crua.
 */
export function isPureBackendText(
	rawReply: string,
	sentReply: string,
	rewrites: RewriteRecord[]
): boolean {
	const replacedByBackend = rewrites.some((record) =>
		BACKEND_AUTHORED_LAYERS.has(record.layer)
	);

	if (!replacedByBackend) {
		return false;
	}

	const rawSentences = new Set(toSentences(rawReply));

	return toSentences(sentReply).every(
		(sentence) => !rawSentences.has(sentence)
	);
}

/**
 * Uma linha por turno. `JSON.stringify` e não `console.info(objeto)`: a forma
 * de objeto passa por `util.inspect`, que corta aninhamento além da
 * profundidade 2 e quebra o objeto em várias linhas, perdendo `usage` e
 * `rewrites` em silêncio. Assim a linha é greppável e passa em `jq`.
 */
export function logTurnTrace(trace: TurnTrace): void {
	console.info(JSON.stringify({ event: "mariana_turn", ...trace }));
}
