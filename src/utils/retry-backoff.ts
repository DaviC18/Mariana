export const DEFAULT_MAX_RETRY_BACKOFF_MS = 5 * 60 * 1000;

/**
 * Backoff exponencial com jitter (50%-100% do delay calculado) para evitar
 * tempestades de retry sincronizadas.
 */
export function computeRetryBackoffMs(
	attempts: number,
	maxBackoffMs = DEFAULT_MAX_RETRY_BACKOFF_MS
): number {
	const exponential = Math.min(
		1000 * 2 ** Math.max(0, attempts - 1),
		maxBackoffMs
	);
	const jittered = Math.floor(exponential * (0.5 + Math.random() * 0.5));
	return Math.max(500, jittered);
}
