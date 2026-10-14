/** biome-ignore-all lint/style/noNonNullAssertion: <> */
/** biome-ignore-all lint/performance/noAwaitInLoops: <> */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import { db } from "../../db/connections";
import { autonomousTasks } from "../../db/schema";
import { computeRetryBackoffMs } from "../../utils/retry-backoff";
import {
	type AutonomousTask,
	mapAutonomousTaskRow,
} from "./autonomous-task-row";

export type { AutonomousTask } from "./autonomous-task-row";

/**
 * Contexto entregue a um handler. O `leaseToken` identifica a posse atual da
 * tarefa e deve ser usado em qualquer escrita que encerre a execução. O
 * `renewLease` permite que tarefas longas mantenham a posse.
 */
export interface AutonomousTaskHandlerContext {
	leaseToken: string;
	renewLease: () => Promise<boolean>;
	task: AutonomousTask;
}

export type AutonomousTaskHandler = (
	context: AutonomousTaskHandlerContext
) => Promise<Record<string, unknown> | undefined>;

export interface AutonomousTaskExecutorOptions {
	conversationId?: string;
	handlers: Record<string, AutonomousTaskHandler>;
	leaseMs?: number;
}

export type AutonomousTaskExecutionResult =
	| { status: "idle" }
	| { leaseLost: true; status: "lease_lost"; taskId: string }
	| { status: "completed"; taskId: string }
	| { status: "retry_scheduled"; taskId: string; error: string }
	| { status: "failed"; taskId: string; error: string };

export class AutonomousTaskLeaseLostError extends Error {
	constructor(taskId: string) {
		super(`Lease lost for autonomous task ${taskId}`);
		this.name = "AutonomousTaskLeaseLostError";
	}
}

export const DEFAULT_TASK_LEASE_MS = 60_000;

/**
 * Reclama atomicamente a próxima tarefa elegível. A cláusula NOT EXISTS
 * serializa o processamento por conversa: enquanto há uma tarefa em
 * `processing` para a conversa, nenhuma outra é reclamada, preservando a
 * ordenação das respostas.
 */
async function claimNextTask({
	leaseMs,
	conversationId,
}: {
	leaseMs: number;
	conversationId?: string;
}): Promise<AutonomousTask | undefined> {
	const leaseToken = randomUUID();
	const leaseExpiresAt = new Date(Date.now() + leaseMs);

	const conversationFilter = conversationId
		? sql`AND task."conversationId" = ${conversationId}`
		: sql``;

	const rows = (await db.execute(
		sql`
    WITH candidate AS (
      SELECT task."id"
      FROM "autonomous_tasks" AS task
      WHERE task."status" = 'pending'
        AND task."availableAt" <= now()
        AND task."attempts" < task."maxAttempts"
        ${conversationFilter}
        AND NOT EXISTS (
          SELECT 1
          FROM "autonomous_tasks" AS other
          WHERE other."conversationId" = task."conversationId"
            AND other."status" = 'processing'
        )
				AND NOT EXISTS (
					SELECT 1
					FROM "autonomous_tasks" AS older
					WHERE older."conversationId" = task."conversationId"
						AND older."status" = 'pending'
						AND older."attempts" < older."maxAttempts"
						AND (
							older."createdAt" < task."createdAt"
							OR (
								older."createdAt" = task."createdAt"
								AND older."id" < task."id"
							)
						)
				)
			ORDER BY task."createdAt", task."id"
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE "autonomous_tasks" AS task
    SET
      "status" = 'processing',
      "attempts" = task."attempts" + 1,
      "lockedAt" = now(),
      "startedAt" = COALESCE(task."startedAt", now()),
      "leaseToken" = ${leaseToken},
      "leaseExpiresAt" = ${leaseExpiresAt.toISOString()},
      "updatedAt" = now()
    FROM candidate
    WHERE task."id" = candidate."id"
    RETURNING task.*
  `
	)) as Record<string, unknown>[];

	return rows[0] ? mapAutonomousTaskRow(rows[0]) : undefined;
}

/** Renova o lease da tarefa desde que o token ainda seja o dono. */
export async function renewTaskLease({
	taskId,
	leaseToken,
	leaseMs = DEFAULT_TASK_LEASE_MS,
}: {
	taskId: string;
	leaseToken: string;
	leaseMs?: number;
}): Promise<boolean> {
	const [renewed] = await db
		.update(autonomousTasks)
		.set({
			leaseExpiresAt: new Date(Date.now() + leaseMs),
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(autonomousTasks.id, taskId),
				eq(autonomousTasks.status, "processing"),
				eq(autonomousTasks.leaseToken, leaseToken)
			)
		)
		.returning({ id: autonomousTasks.id });

	return Boolean(renewed);
}

async function markCompleted({
	taskId,
	leaseToken,
	result,
}: {
	taskId: string;
	leaseToken: string;
	result: Record<string, unknown>;
}): Promise<void> {
	const updated = await db
		.update(autonomousTasks)
		.set({
			completedAt: new Date(),
			lastError: null,
			leaseExpiresAt: null,
			leaseToken: null,
			lockedAt: null,
			result,
			status: "completed",
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(autonomousTasks.id, taskId),
				eq(autonomousTasks.status, "processing"),
				eq(autonomousTasks.leaseToken, leaseToken)
			)
		)
		.returning({ id: autonomousTasks.id });

	if (!updated[0]) {
		throw new AutonomousTaskLeaseLostError(taskId);
	}
}

async function markFailedOrRetry({
	task,
	leaseToken,
	error,
	retryable,
}: {
	task: AutonomousTask;
	leaseToken: string;
	error: unknown;
	retryable: boolean;
}): Promise<AutonomousTaskExecutionResult> {
	const errorMessage = error instanceof Error ? error.message : String(error);

	const shouldRetry = retryable && task.attempts < task.maxAttempts;
	const now = new Date();

	const [updatedTask] = await db
		.update(autonomousTasks)
		.set({
			availableAt: shouldRetry
				? new Date(now.getTime() + computeRetryBackoffMs(task.attempts))
				: task.availableAt,
			lastError: errorMessage,
			leaseExpiresAt: null,
			leaseToken: null,
			lockedAt: null,
			status: shouldRetry ? "pending" : "failed",
			updatedAt: now,
		})
		.where(
			and(
				eq(autonomousTasks.id, task.id),
				eq(autonomousTasks.status, "processing"),
				eq(autonomousTasks.leaseToken, leaseToken)
			)
		)
		.returning({ id: autonomousTasks.id });

	if (!updatedTask) {
		return {
			leaseLost: true,
			status: "lease_lost",
			taskId: task.id,
		};
	}

	if (shouldRetry) {
		return {
			error: errorMessage,
			status: "retry_scheduled",
			taskId: task.id,
		};
	}

	return {
		error: errorMessage,
		status: "failed",
		taskId: task.id,
	};
}

export interface RunAutonomousTaskOptions {
	retryable?: (error: unknown) => boolean;
}

/**
 * Erros lançados por handlers são tratados como retryáveis por padrão. Um
 * handler pode lançar `PermanentAutonomousTaskError` para indicar falha
 * permanente (terminal, observável, sem novas tentativas).
 */
export class PermanentAutonomousTaskError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "PermanentAutonomousTaskError";
	}
}

export class TransientAutonomousTaskError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "TransientAutonomousTaskError";
	}
}

function defaultIsRetryable(error: unknown): boolean {
	if (error instanceof PermanentAutonomousTaskError) {
		return false;
	}
	return true;
}

export async function executeNextAutonomousTask({
	conversationId,
	handlers,
	leaseMs = DEFAULT_TASK_LEASE_MS,
	retryable = defaultIsRetryable,
}: AutonomousTaskExecutorOptions &
	RunAutonomousTaskOptions): Promise<AutonomousTaskExecutionResult> {
	const task = await claimNextTask({ conversationId, leaseMs });

	if (!task?.leaseToken) {
		return { status: "idle" };
	}

	const { leaseToken } = task;
	const handler = handlers[task.taskType];

	if (!handler) {
		return markFailedOrRetry({
			error: new Error(`Unsupported autonomous task type: ${task.taskType}`),
			leaseToken,
			retryable: false,
			task: { ...task, attempts: task.maxAttempts },
		});
	}

	try {
		const result = await handler({
			leaseToken,
			renewLease: () =>
				renewTaskLease({ leaseMs, leaseToken, taskId: task.id }),
			task,
		});

		await markCompleted({ leaseToken, result: result ?? {}, taskId: task.id });

		return {
			status: "completed",
			taskId: task.id,
		};
	} catch (error) {
		if (error instanceof AutonomousTaskLeaseLostError) {
			return { leaseLost: true, status: "lease_lost", taskId: task.id };
		}

		return markFailedOrRetry({
			error,
			leaseToken,
			retryable: retryable(error),
			task,
		});
	}
}

/**
 * Recupera tarefas abandonadas: qualquer tarefa em `processing` cujo lease
 * expirou volta a ser elegível (ou falha em definitivo quando esgotou as
 * tentativas). Não depende de um novo webhook.
 */
export async function recoverStaleAutonomousTasks({
	now = new Date(),
}: {
	now?: Date;
} = {}): Promise<{ recovered: number; failed: number }> {
	const recoveredRows = (await db.execute(
		sql`
    UPDATE "autonomous_tasks"
    SET
      "status" = CASE
        WHEN "attempts" < "maxAttempts" THEN 'pending'::"autonomous_task_status"
        ELSE 'failed'::"autonomous_task_status"
      END,
      "availableAt" = ${now.toISOString()},
      "lastError" = COALESCE("lastError", 'processing lease expired'),
      "leaseToken" = NULL,
      "leaseExpiresAt" = NULL,
      "lockedAt" = NULL,
      "updatedAt" = now()
    WHERE "status" = 'processing'
      AND "leaseExpiresAt" IS NOT NULL
      AND "leaseExpiresAt" <= ${now.toISOString()}
    RETURNING "status"
  `
	)) as { status: string }[];

	const failed = recoveredRows.filter((row) => row.status === "failed").length;

	return {
		failed,
		recovered: recoveredRows.length - failed,
	};
}

/**
 * Executa tarefas pendentes até a fila esvaziar. Usado pelo loop do worker e
 * como seam determinístico em testes/integrações.
 */
export async function runAutonomousTasksUntilIdle({
	conversationId,
	handlers,
	leaseMs = DEFAULT_TASK_LEASE_MS,
	maxIterations = 200,
	retryable,
}: AutonomousTaskExecutorOptions &
	RunAutonomousTaskOptions & { maxIterations?: number }): Promise<number> {
	await recoverStaleAutonomousTasks();

	let processed = 0;

	for (let iteration = 0; iteration < maxIterations; iteration += 1) {
		const result = await executeNextAutonomousTask({
			conversationId,
			handlers,
			leaseMs,
			retryable,
		});

		if (result.status === "idle") {
			break;
		}

		processed += 1;
	}

	return processed;
}
