import type { InferSelectModel } from "drizzle-orm";
import { and, eq, sql } from "drizzle-orm";

import { db } from "../../db/connections";
import { autonomousTasks } from "../../db/schema";

type AutonomousTask = InferSelectModel<typeof autonomousTasks>;

export type AutonomousTaskHandler = (
	task: AutonomousTask
) => Promise<Record<string, unknown> | undefined>;

export interface AutonomousTaskExecutorOptions {
	handlers: Record<string, AutonomousTaskHandler>;
}

export type AutonomousTaskExecutionResult =
	| { status: "idle" }
	| { status: "completed"; taskId: string }
	| { status: "retry_scheduled"; taskId: string; error: string }
	| { status: "failed"; taskId: string; error: string };

async function claimNextTask(): Promise<AutonomousTask | undefined> {
	const rows = (await db.execute(
		sql<AutonomousTask>`clear
    WITH candidate AS (
      SELECT "id"
      FROM "autonomous_tasks"
      WHERE "status" = 'pending'
        AND "availableAt" <= now()
        AND "attempts" < "maxAttempts"
      ORDER BY "availableAt", "createdAt"
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE "autonomous_tasks" AS task
    SET
      "status" = 'processing',
      "attempts" = task."attempts" + 1,
      "lockedAt" = now(),
      "startedAt" = COALESCE(task."startedAt", now()),
      "updatedAt" = now()
    FROM candidate
    WHERE task."id" = candidate."id"
    RETURNING task.*
  `
	)) as AutonomousTask[];

	return rows[0] as AutonomousTask | undefined;
}

async function markCompleted(
	taskId: string,
	result: Record<string, unknown>
): Promise<void> {
	const [updatedTask] = await db
		.update(autonomousTasks)
		.set({
			completedAt: new Date(),
			lastError: null,
			lockedAt: null,
			result,
			status: "completed",
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(autonomousTasks.id, taskId),
				eq(autonomousTasks.status, "processing")
			)
		)
		.returning({ id: autonomousTasks.id });

	if (!updatedTask) {
		throw new Error(`Could not complete autonomous task ${taskId}`);
	}
}

async function markFailedOrRetry(
	task: AutonomousTask,
	error: unknown
): Promise<AutonomousTaskExecutionResult> {
	const errorMessage = error instanceof Error ? error.message : String(error);

	const shouldRetry = task.attempts < task.maxAttempts;

	// Backoff exponencial limitado a 5 minutos.
	const delayMs = Math.min(
		1000 * 2 ** Math.max(0, task.attempts - 1),
		5 * 60 * 1000
	);

	const now = new Date();

	const [updatedTask] = await db
		.update(autonomousTasks)
		.set({
			availableAt: shouldRetry
				? new Date(now.getTime() + delayMs)
				: task.availableAt,
			lastError: errorMessage,
			lockedAt: null,
			status: shouldRetry ? "pending" : "failed",
			updatedAt: now,
		})
		.where(
			and(
				eq(autonomousTasks.id, task.id),
				eq(autonomousTasks.status, "processing")
			)
		)
		.returning({ id: autonomousTasks.id });

	if (!updatedTask) {
		throw new Error(`Could not update failed task ${task.id}`);
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

export async function executeNextAutonomousTask({
	handlers,
}: AutonomousTaskExecutorOptions): Promise<AutonomousTaskExecutionResult> {
	const task = await claimNextTask();

	if (!task) {
		return { status: "idle" };
	}

	const handler = handlers[task.taskType];

	if (!handler) {
		return markFailedOrRetry(
			{ ...task, attempts: task.maxAttempts },
			new Error(`Unsupported autonomous task type: ${task.taskType}`)
		);
	}

	try {
		const result = await handler(task);

		await markCompleted(task.id, result ?? {});

		return {
			status: "completed",
			taskId: task.id,
		};
	} catch (error) {
		return markFailedOrRetry(task, error);
	}
}
