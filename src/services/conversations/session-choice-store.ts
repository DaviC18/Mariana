/** biome-ignore-all lint/style/useFilenamingConvention: <> */
import { and, eq, ne, sql } from "drizzle-orm";

import { db } from "../../db/connections";
import { autonomousTasks } from "../../db/schema";
import { SESSION_CHOICE_STATE_TASK } from "./autonomous-task-handlers";

/**
 * Estado pendente da escolha de sessão gravado em `autonomous_tasks`.
 *
 * A linha usa `status = "completed"` de propósito: o executor só reclama
 * `pending`, então ela nunca é executada, não tem lease e não bloqueia a
 * ordenação da conversa. É uso da tabela como chave-valor durável enquanto
 * não existe coluna `jsonb` em `conversations` (migration congelada).
 */
export interface SessionChoiceSnapshot {
	commercialApproach: string | null;
	consortiumType: string | null;
	currentSituation: string | null;
	interestedInConsultant: boolean;
	objective: string | null;
	painPoint: string | null;
	qualifiedAt: string | null;
	status: string;
	urgency: string | null;
}

export interface SessionChoiceState {
	askedAt: string;
	discardButtonId?: string;
	kind: "session_choice";
	leadId: string;
	newConversationId?: string;
	previousConversationId: string;
	questionMessageId?: string;
	questionOutboundId?: string;
	resolvedAt?: string;
	snapshot?: SessionChoiceSnapshot;
	state: "pending" | "continue" | "new";
	triggerExternalId?: string;
	triggerMessageId?: string;
}

export type SessionChoiceExecutor = Pick<
	typeof db,
	"insert" | "select" | "update"
>;

export function sessionChoiceStateKey(conversationId: string): string {
	return `session-choice-state:${conversationId}`;
}

function asState(payload: Record<string, unknown>): SessionChoiceState {
	return payload as unknown as SessionChoiceState;
}

/**
 * Abre o estado pendente. `ON CONFLICT DO NOTHING` garante idempotência: um
 * estado já resolvido nunca é reaberto.
 */
export async function openSessionChoice({
	askedAt = new Date(),
	conversationId,
	discardButtonId,
	executor = db,
	leadId,
	snapshot,
	triggerExternalId,
	triggerMessageId,
}: {
	askedAt?: Date;
	conversationId: string;
	discardButtonId?: string;
	executor?: SessionChoiceExecutor;
	leadId: string;
	snapshot?: SessionChoiceSnapshot;
	triggerExternalId?: string;
	triggerMessageId?: string;
}): Promise<SessionChoiceState | null> {
	const payload: SessionChoiceState = {
		askedAt: askedAt.toISOString(),
		kind: "session_choice",
		leadId,
		previousConversationId: conversationId,
		state: "pending",
		...(discardButtonId ? { discardButtonId } : {}),
		...(snapshot ? { snapshot } : {}),
		...(triggerExternalId ? { triggerExternalId } : {}),
		...(triggerMessageId ? { triggerMessageId } : {}),
	};

	const [inserted] = await executor
		.insert(autonomousTasks)
		.values({
			conversationId,
			idempotencyKey: sessionChoiceStateKey(conversationId),
			payload: payload as unknown as Record<string, unknown>,
			status: "completed",
			taskType: SESSION_CHOICE_STATE_TASK,
		})
		.onConflictDoNothing({ target: autonomousTasks.idempotencyKey })
		.returning({ payload: autonomousTasks.payload });

	return inserted ? asState(inserted.payload) : null;
}

/** Lê o estado somente enquanto `state = "pending"`. */
export async function readPendingSessionChoice(
	conversationId: string,
	executor: SessionChoiceExecutor = db
): Promise<SessionChoiceState | null> {
	const [row] = await executor
		.select({ payload: autonomousTasks.payload })
		.from(autonomousTasks)
		.where(
			and(
				eq(
					autonomousTasks.idempotencyKey,
					sessionChoiceStateKey(conversationId)
				),
				eq(autonomousTasks.taskType, SESSION_CHOICE_STATE_TASK),
				sql`${autonomousTasks.payload}->>'state' = 'pending'`
			)
		)
		.limit(1);

	return row ? asState(row.payload) : null;
}

/**
 * Resolve a escolha com UPDATE condicional: exatamente um chamador vence.
 * Quem perder recebe `null` e deve responder o texto de "já registrada".
 */
export async function claimSessionChoice({
	conversationId,
	executor = db,
	resolvedAt = new Date(),
	state,
}: {
	conversationId: string;
	executor?: SessionChoiceExecutor;
	resolvedAt?: Date;
	state: "continue" | "new";
}): Promise<SessionChoiceState | null> {
	const patch = { resolvedAt: resolvedAt.toISOString(), state };

	const [row] = await executor
		.update(autonomousTasks)
		.set({
			payload: sql`${autonomousTasks.payload} || ${JSON.stringify(patch)}::jsonb`,
			updatedAt: resolvedAt,
		})
		.where(
			and(
				eq(
					autonomousTasks.idempotencyKey,
					sessionChoiceStateKey(conversationId)
				),
				eq(autonomousTasks.taskType, SESSION_CHOICE_STATE_TASK),
				sql`${autonomousTasks.payload}->>'state' = 'pending'`
			)
		)
		.returning({ payload: autonomousTasks.payload });

	return row ? asState(row.payload) : null;
}

/** Grava as referências da pergunta enviada (mensagem e outbox). */
export async function setQuestionMessage({
	conversationId,
	executor = db,
	questionMessageId,
	questionOutboundId,
}: {
	conversationId: string;
	executor?: SessionChoiceExecutor;
	questionMessageId: string;
	questionOutboundId?: string;
}): Promise<SessionChoiceState | null> {
	const patch: Record<string, unknown> = { questionMessageId };
	if (questionOutboundId) {
		patch.questionOutboundId = questionOutboundId;
	}

	const [row] = await executor
		.update(autonomousTasks)
		.set({
			payload: sql`${autonomousTasks.payload} || ${JSON.stringify(patch)}::jsonb`,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(
					autonomousTasks.idempotencyKey,
					sessionChoiceStateKey(conversationId)
				),
				eq(autonomousTasks.taskType, SESSION_CHOICE_STATE_TASK),
				sql`${autonomousTasks.payload}->>'state' = 'pending'`
			)
		)
		.returning({ payload: autonomousTasks.payload });

	return row ? asState(row.payload) : null;
}

/**
 * Encerra (sem apagar) tasks `pending` antigas da conversa quando a pendência
 * abre. A linha de estado é `completed` e não é tocada.
 */
export async function markSupersededTasks({
	conversationId,
	executor = db,
	now = new Date(),
}: {
	conversationId: string;
	executor?: SessionChoiceExecutor;
	now?: Date;
}): Promise<number> {
	const rows = await executor
		.update(autonomousTasks)
		.set({
			completedAt: now,
			result: { supersededBy: "session_choice" },
			status: "completed",
			updatedAt: now,
		})
		.where(
			and(
				eq(autonomousTasks.conversationId, conversationId),
				eq(autonomousTasks.status, "pending"),
				ne(autonomousTasks.taskType, SESSION_CHOICE_STATE_TASK)
			)
		)
		.returning({ id: autonomousTasks.id });

	return rows.length;
}
