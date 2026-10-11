import type { InferSelectModel } from "drizzle-orm";
import { and, eq, sql } from "drizzle-orm";

import { db } from "../../db/connections";
import { autonomousTasks } from "../../db/schema";

export type AutonomousTask = InferSelectModel<typeof autonomousTasks>;

export type AutonomousTaskHandler = (
  task: AutonomousTask
) => Promise<Record<string, unknown> | undefined>;

export interface AutonomousTaskStore {
  claimNextTask(): Promise<AutonomousTask | undefined>;
  markCompleted(taskId: string, result: Record<string, unknown>): Promise<void>;
  markFailedOrRetry(
    task: AutonomousTask,
    error: unknown
  ): Promise<AutonomousTaskExecutionResult>;
}

export interface AutonomousTaskExecutorOptions {
  handlers: Record<string, AutonomousTaskHandler>;
  store?: AutonomousTaskStore;
}

export type AutonomousTaskExecutionResult =
  | { status: "idle" }
  | { status: "completed"; taskId: string }
  | { status: "retry_scheduled"; taskId: string; error: string }
  | { status: "failed"; taskId: string; error: string };

async function claimNextTask(): Promise<AutonomousTask | undefined> {
  const rows = await db.execute(sql<AutonomousTask>`
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
  `);

  return (rows as unknown as AutonomousTask[])[0];
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

  return shouldRetry
    ? { status: "retry_scheduled", taskId: task.id, error: errorMessage }
    : { status: "failed", taskId: task.id, error: errorMessage };
}

const databaseStore: AutonomousTaskStore = {
  claimNextTask,
  markCompleted,
  markFailedOrRetry,
};

export async function executeNextAutonomousTask({
  handlers,
  store = databaseStore,
}: AutonomousTaskExecutorOptions): Promise<AutonomousTaskExecutionResult> {
  const task = await store.claimNextTask();

  if (!task) {
    return { status: "idle" };
  }

  const handler = handlers[task.taskType];

  if (!handler) {
    // A configuração inválida não melhora com novas tentativas.
    return store.markFailedOrRetry(
      { ...task, attempts: task.maxAttempts },
      new Error(`Unsupported autonomous task type: ${task.taskType}`)
    );
  }

  let result: Record<string, unknown> | undefined;

  try {
    result = await handler(task);
  } catch (error) {
    return store.markFailedOrRetry(task, error);
  }

  // Não reagendar automaticamente se a execução funcionou, mas a persistência
  // do resultado falhou: isso poderia repetir efeitos externos, como mensagens.
  // A recuperação de leases expirados deve tratar tarefas que ficaram processing.
  await store.markCompleted(task.id, result ?? {});

  return { status: "completed", taskId: task.id };
}
