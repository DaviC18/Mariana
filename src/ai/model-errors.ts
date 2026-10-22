/**
 * Falha do modelo, não de conteúdo. Envolve só as três formas pelas quais a
 * chamada ao Gemini não produz JSON utilizável:
 * - `transport`: a chamada rejeitou (404 de id de modelo errado, timeout, 5xx
 *   depois dos retries de `client.ts`);
 * - `empty_response`: a API respondeu sem texto;
 * - `invalid_json`: o texto não é JSON.
 *
 * Os guardrails (L2 em `validate-response.ts`, L4 em `mariana-safety.ts`)
 * **não** são envolvidos: são problema de conteúdo, com outro tratamento, e
 * continuam lançando exatamente como antes.
 */
export type ModelFailureKind = "transport" | "empty_response" | "invalid_json";

export class ModelUnavailableError extends Error {
	readonly kind: ModelFailureKind;

	constructor(
		message: string,
		options: { cause?: unknown; kind: ModelFailureKind }
	) {
		super(message, { cause: options.cause });
		this.name = "ModelUnavailableError";
		this.kind = options.kind;
	}
}
