/** biome-ignore-all lint/style/useFilenamingConvention: <> */

export interface DebouncedMessage {
	content: string;
	id: string;
	receivedAt: Date;
}

export interface ProcessDebouncedMessagesInput {
	conversationId: string;
	messages: DebouncedMessage[];
}

interface PendingConversation {
	messages: DebouncedMessage[];
	process: (input: ProcessDebouncedMessagesInput) => Promise<void>;
	timer: ReturnType<typeof setTimeout>;
}

export class MessageDebounceCoordinator {
	private readonly pending = new Map<string, PendingConversation>();
	private readonly debounceMs: number;

	constructor(debounceMs: number) {
		this.debounceMs = debounceMs;
	}

	schedule({
		conversationId,
		message,
		process,
	}: {
		conversationId: string;
		message: DebouncedMessage;
		process: (input: ProcessDebouncedMessagesInput) => Promise<void>;
	}): void {
		const previous = this.pending.get(conversationId);
		if (previous) {
			clearTimeout(previous.timer);
		}

		const messages = previous?.messages ?? [];
		if (!messages.some((pendingMessage) => pendingMessage.id === message.id)) {
			messages.push(message);
		}

		const timer = setTimeout(() => {
			this.release(conversationId, messages, process).catch((error) => {
				console.error("Failed to process debounced messages", {
					conversationId,
					error,
				});
			});
		}, this.debounceMs);

		this.pending.set(conversationId, {
			messages,
			process,
			timer,
		});
	}

	hasPending(conversationId: string): boolean {
		return this.pending.has(conversationId);
	}

	async flush(conversationId: string): Promise<void> {
		const pending = this.pending.get(conversationId);
		if (!pending) {
			return;
		}
		clearTimeout(pending.timer);
		await this.release(conversationId, pending.messages, pending.process);
	}

	private async release(
		conversationId: string,
		messages: DebouncedMessage[],
		process: (input: ProcessDebouncedMessagesInput) => Promise<void>
	): Promise<void> {
		const pending = this.pending.get(conversationId);
		if (!pending || pending.messages !== messages) {
			return;
		}

		this.pending.delete(conversationId);
		await process({ conversationId, messages: [...messages] });
	}
}
