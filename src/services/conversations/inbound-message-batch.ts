import { toDate } from "../../db/raw-row";

export interface InboundBatchTask {
	createdAt: Date;
	id: string;
	payload: Record<string, unknown>;
	triggerMessageId: string | null;
}

export interface InboundBatchCandidate {
	content: string;
	createdAt: Date;
	id: string;
	taskCreatedAt: Date;
	taskId: string;
	taskPayload: Record<string, unknown>;
}

export function getInboundBatchCutoffAt(task: InboundBatchTask): Date {
	const cutoffValue = task.payload.batchCutoffAt;
	if (typeof cutoffValue === "string") {
		const cutoffAt = new Date(cutoffValue);
		if (Number.isFinite(cutoffAt.getTime())) {
			return cutoffAt;
		}
	}

	return toDate(task.createdAt);
}

function toTime(value: Date | string): number {
	return toDate(value).getTime();
}

export function selectInboundMessageBatch({
	anchorTask,
	candidates,
}: {
	anchorTask: InboundBatchTask;
	candidates: InboundBatchCandidate[];
}): InboundBatchCandidate[] {
	const cutoffValue = anchorTask.payload.batchCutoffAt;
	const cutoffAt = getInboundBatchCutoffAt(anchorTask);
	const anchorTime = toTime(anchorTask.createdAt);

	return candidates
		.filter((candidate) => {
			if (candidate.taskId === anchorTask.id) {
				return true;
			}

			// Compara por `getTime()`: um timestamp vindo como string de um
			// `db.execute` cru faria `Date >= string` ser sempre `false`.
			const candidateTime = toTime(candidate.taskCreatedAt);
			return (
				typeof cutoffValue === "string" &&
				candidate.taskPayload.batchCutoffAt === cutoffValue &&
				candidateTime >= anchorTime &&
				candidateTime <= cutoffAt.getTime()
			);
		})
		.sort((left, right) => {
			const timeDifference =
				toTime(left.taskCreatedAt) - toTime(right.taskCreatedAt);
			return timeDifference || left.taskId.localeCompare(right.taskId);
		});
}

export function buildInboundReplyIdempotencyKey(
	conversationId: string,
	triggerMessageId: string
): string {
	return `mariana-reply:${conversationId}:${triggerMessageId}`;
}
