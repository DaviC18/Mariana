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

	return task.createdAt;
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

	return candidates
		.filter((candidate) => {
			if (candidate.taskId === anchorTask.id) {
				return true;
			}

			return (
				typeof cutoffValue === "string" &&
				candidate.taskPayload.batchCutoffAt === cutoffValue &&
				candidate.taskCreatedAt >= anchorTask.createdAt &&
				candidate.taskCreatedAt <= cutoffAt
			);
		})
		.sort((left, right) => {
			const timeDifference =
				left.taskCreatedAt.getTime() - right.taskCreatedAt.getTime();
			return timeDifference || left.taskId.localeCompare(right.taskId);
		});
}

export function buildInboundReplyIdempotencyKey(
	conversationId: string,
	triggerMessageId: string
): string {
	return `mariana-reply:${conversationId}:${triggerMessageId}`;
}
