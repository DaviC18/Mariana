import assert from "node:assert/strict";
import test from "node:test";

import type {
  AutonomousTask,
  AutonomousTaskExecutionResult,
  AutonomousTaskStore,
} from "../../../services/conversations/autonomous-task-executor";
import { executeNextAutonomousTask } from "../../../services/conversations/autonomous-task-executor";

function createTask(
  overrides: Partial<AutonomousTask> = {}
): AutonomousTask {
  return {
    attempts: 1,
    availableAt: new Date(),
    completedAt: null,
    conversationId: "00000000-0000-4000-8000-000000000001",
    createdAt: new Date(),
    id: "00000000-0000-4000-8000-000000000002",
    idempotencyKey: "test-task-key",
    lastError: null,
    lockedAt: new Date(),
    maxAttempts: 3,
    maxSteps: 8,
    payload: {},
    result: null,
    startedAt: new Date(),
    status: "processing",
    stepNumber: 0,
    taskType: "process_inbound",
    triggerMessageId: "00000000-0000-4000-8000-000000000003",
    updatedAt: new Date(),
    workflowId: "00000000-0000-4000-8000-000000000004",
    ...overrides,
  } as AutonomousTask;
}

function createStore(task?: AutonomousTask) {
  const calls = {
    claim: 0,
    completed: [] as Array<{ taskId: string; result: Record<string, unknown> }>,
    failures: [] as Array<{ task: AutonomousTask; error: unknown }>,
  };

  const store: AutonomousTaskStore = {
    async claimNextTask() {
      calls.claim += 1;
      return task;
    },
    async markCompleted(taskId, result) {
      calls.completed.push({ taskId, result });
    },
    async markFailedOrRetry(
      failedTask,
      error
    ): Promise<AutonomousTaskExecutionResult> {
      calls.failures.push({ task: failedTask, error });
      const message = error instanceof Error ? error.message : String(error);
      return failedTask.attempts < failedTask.maxAttempts
        ? { status: "retry_scheduled", taskId: failedTask.id, error: message }
        : { status: "failed", taskId: failedTask.id, error: message };
    },
  };

  return { calls, store };
}

test("returns idle when there are no pending tasks", async () => {
  const { calls, store } = createStore();

  const result = await executeNextAutonomousTask({ handlers: {}, store });

  assert.deepEqual(result, { status: "idle" });
  assert.equal(calls.claim, 1);
  assert.equal(calls.completed.length, 0);
  assert.equal(calls.failures.length, 0);
});

test("executes the matching handler and persists its result", async () => {
  const task = createTask();
  const { calls, store } = createStore(task);
  let handlerCalls = 0;

  const result = await executeNextAutonomousTask({
    handlers: {
      process_inbound: async (receivedTask) => {
        handlerCalls += 1;
        assert.equal(receivedTask.id, task.id);
        return { nextAction: "continue_qualification" };
      },
    },
    store,
  });

  assert.deepEqual(result, { status: "completed", taskId: task.id });
  assert.equal(handlerCalls, 1);
  assert.deepEqual(calls.completed, [
    { taskId: task.id, result: { nextAction: "continue_qualification" } },
  ]);
  assert.equal(calls.failures.length, 0);
});

test("schedules a retry when a handler throws and attempts remain", async () => {
  const task = createTask({ attempts: 1, maxAttempts: 3 });
  const { calls, store } = createStore(task);

  const result = await executeNextAutonomousTask({
    handlers: {
      process_inbound: async () => {
        throw new Error("temporary failure");
      },
    },
    store,
  });

  assert.deepEqual(result, {
    status: "retry_scheduled",
    taskId: task.id,
    error: "temporary failure",
  });
  assert.equal(calls.failures.length, 1);
  assert.equal(calls.completed.length, 0);
});

test("marks unsupported task types as failed without retrying", async () => {
  const task = createTask({ taskType: "unknown", attempts: 1, maxAttempts: 3 });
  const { calls, store } = createStore(task);

  const result = await executeNextAutonomousTask({ handlers: {}, store });

  assert.deepEqual(result, {
    status: "failed",
    taskId: task.id,
    error: "Unsupported autonomous task type: unknown",
  });
  assert.equal(calls.failures.length, 1);
  assert.equal(calls.failures[0]?.task.attempts, task.maxAttempts);
});

test("propagates result-persistence errors without re-running the handler", async () => {
  const task = createTask();
  const { calls, store } = createStore(task);
  let handlerCalls = 0;
  store.markCompleted = async () => {
    throw new Error("database unavailable");
  };

  await assert.rejects(
    executeNextAutonomousTask({
      handlers: {
        process_inbound: async () => {
          handlerCalls += 1;
          return { sent: true };
        },
      },
      store,
    }),
    /database unavailable/
  );

  assert.equal(handlerCalls, 1);
  assert.equal(calls.failures.length, 0);
});
