/** biome-ignore-all lint/style/useFilenamingConvention: <> */
/** biome-ignore-all lint/performance/noAwaitInLoops: <> */

import { env } from "../../env";
import {
	executeNextAutonomousTask,
	recoverStaleAutonomousTasks,
} from "../conversations/autonomous-task-executor";
import { createAutonomousTaskHandlers } from "../conversations/autonomous-task-handlers";
import {
	executeNextOutboundMessage,
	type OutboundSender,
	recoverStaleOutboundMessages,
} from "../messaging/outbound-messages";
import { PollingWorker, type PollingWorkerLogger } from "./polling-worker";

const CONVERSATION_BATCH_SIZE = 10;

let autonomousTaskWorker: PollingWorker | undefined;
let outboundMessageWorker: PollingWorker | undefined;

export function startReliabilityWorkers({
	logger,
}: {
	logger?: PollingWorkerLogger;
} = {}): { started: string[] } {
	if (autonomousTaskWorker || outboundMessageWorker) {
		return { started: [] };
	}

	const handlers = createAutonomousTaskHandlers();

	autonomousTaskWorker = new PollingWorker({
		logger,
		name: "autonomous-task-worker",
		pollIntervalMs: env.AUTONOMOUS_TASK_POLL_MS,
		runOnce: async () => {
			let processed = 0;

			for (let index = 0; index < CONVERSATION_BATCH_SIZE; index += 1) {
				const result = await executeNextAutonomousTask({ handlers });
				if (result.status === "idle") {
					break;
				}
				processed += 1;
			}

			if (processed === 0) {
				await recoverStaleAutonomousTasks();
			}

			return processed;
		},
	});

	outboundMessageWorker = new PollingWorker({
		logger,
		name: "outbound-message-worker",
		pollIntervalMs: env.OUTBOUND_MESSAGE_POLL_MS,
		runOnce: async () => {
			let processed = 0;

			for (let index = 0; index < CONVERSATION_BATCH_SIZE; index += 1) {
				const result = await executeNextOutboundMessage();
				if (result.status === "idle") {
					break;
				}
				processed += 1;
			}

			if (processed === 0) {
				await recoverStaleOutboundMessages();
			}

			return processed;
		},
	});

	autonomousTaskWorker.start();
	outboundMessageWorker.start();

	return {
		started: ["autonomous-task-worker", "outbound-message-worker"],
	};
}

export async function stopReliabilityWorkers(): Promise<void> {
	await Promise.all([
		autonomousTaskWorker?.stop(),
		outboundMessageWorker?.stop(),
	]);
	autonomousTaskWorker = undefined;
	outboundMessageWorker = undefined;
}

/**
 * Drena, de forma determinística, todo o trabalho durável de uma conversa:
 * tarefas autônomas pendentes e depois as mensagens de saída. Usado por
 * integrações/testes para substituir o antigo debounce em memória.
 */
export async function drainConversationWork(
	conversationId: string,
	{ sender }: { sender?: OutboundSender } = {}
): Promise<{ outbound: number; tasks: number }> {
	const handlers = createAutonomousTaskHandlers();

	let tasks = 0;
	for (let index = 0; index < 50; index += 1) {
		const result = await executeNextAutonomousTask({
			conversationId,
			handlers,
		});
		if (result.status === "idle") {
			break;
		}
		tasks += 1;
	}

	let outbound = 0;
	for (let index = 0; index < 50; index += 1) {
		const result = await executeNextOutboundMessage({
			conversationId,
			sender,
		});
		if (result.status === "idle") {
			break;
		}
		outbound += 1;
	}

	return { outbound, tasks };
}
