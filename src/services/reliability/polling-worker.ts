/** biome-ignore-all lint/performance/noAwaitInLoops: <> */
/** biome-ignore-all lint/suspicious/noUnnecessaryConditions: <> */

export interface PollingWorkerLogger {
	error: (context: Record<string, unknown>, message?: string) => void;
	info: (context: Record<string, unknown>, message?: string) => void;
}

/**
 * Worker de polling genérico. Executa `runOnce` continuamente: enquanto houver
 * trabalho ele roda sem esperar; quando não há, aguarda `pollIntervalMs`.
 * `stop` interrompe o loop de forma cooperativa e aguarda a execução atual.
 */
export class PollingWorker {
	readonly name: string;
	private readonly runOnce: () => Promise<number>;
	private readonly pollIntervalMs: number;
	private readonly logger?: PollingWorkerLogger;

	private readonly state = { running: false };
	private loopPromise?: Promise<void>;
	private wakeup?: () => void;

	constructor({
		name,
		runOnce,
		pollIntervalMs,
		logger,
	}: {
		name: string;
		runOnce: () => Promise<number>;
		pollIntervalMs: number;
		logger?: PollingWorkerLogger;
	}) {
		this.name = name;
		this.runOnce = runOnce;
		this.pollIntervalMs = pollIntervalMs;
		this.logger = logger;
	}

	start(): void {
		if (this.state.running) {
			return;
		}

		this.state.running = true;
		this.loopPromise = this.loop();
	}

	async stop(): Promise<void> {
		this.state.running = false;
		this.wakeup?.();
		await this.loopPromise;
		this.loopPromise = undefined;
	}

	private async waitForNextPoll(): Promise<void> {
		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				this.wakeup = undefined;
				resolve();
			}, this.pollIntervalMs);

			this.wakeup = () => {
				clearTimeout(timeout);
				this.wakeup = undefined;
				resolve();
			};
		});
	}

	private async loop(): Promise<void> {
		while (this.state.running) {
			let processed = 0;

			try {
				processed = await this.runOnce();
			} catch (error) {
				this.logger?.error(
					{ err: error, worker: this.name },
					"Background worker iteration failed"
				);
			}

			if (!this.state.running) {
				break;
			}

			if (processed === 0) {
				await this.waitForNextPoll();
			}
		}
	}
}
