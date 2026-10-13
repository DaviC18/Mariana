/**
 * Erro tipado de envio pela API do WhatsApp (Graph API).
 *
 * Classifica a falha para que o outbox consiga decidir entre:
 *   - reenviar (retryable),
 *   - falhar em definitivo (permanente),
 *   - marcar como incerto (unknown).
 */
export type WhatsAppSendErrorKind = "permanent" | "retryable" | "uncertain";

export class WhatsAppSendError extends Error {
	readonly kind: WhatsAppSendErrorKind;
	readonly httpStatus?: number;
	readonly providerCode?: number;
	readonly providerSubcode?: number;
	readonly responseBody?: string;

	constructor({
		kind,
		message,
		httpStatus,
		providerCode,
		providerSubcode,
		responseBody,
		cause,
	}: {
		kind: WhatsAppSendErrorKind;
		message: string;
		httpStatus?: number;
		providerCode?: number;
		providerSubcode?: number;
		responseBody?: string;
		cause?: unknown;
	}) {
		super(message, { cause });
		this.name = "WhatsAppSendError";
		this.kind = kind;
		this.httpStatus = httpStatus;
		this.providerCode = providerCode;
		this.providerSubcode = providerSubcode;
		this.responseBody = responseBody;
	}

	get retryable(): boolean {
		return this.kind === "retryable";
	}

	get uncertain(): boolean {
		return this.kind === "uncertain";
	}
}

function parseProviderError(
	body: string
): { code?: number; subcode?: number } | undefined {
	try {
		const parsed = JSON.parse(body) as {
			error?: { code?: number; error_subcode?: number };
		};
		return {
			code: parsed.error?.code,
			subcode: parsed.error?.error_subcode,
		};
	} catch {
		return undefined;
	}
}

/**
 * Classifica o status HTTP da Graph API em um tipo de falha.
 *
 * 408/429/5xx são transitórios. 4xx são permanentes (payload inválido,
 * token inválido, política). O restante é tratado como incerto para não
 * arriscar reenvios que gerariam mensagens duplicadas.
 */
export function classifyWhatsAppHttpError(
	httpStatus: number,
	responseBody: string
): WhatsAppSendError {
	const { code, subcode } = parseProviderError(responseBody) ?? {};

	if (httpStatus === 408 || httpStatus === 429 || httpStatus >= 500) {
		return new WhatsAppSendError({
			httpStatus,
			kind: "retryable",
			message: `WhatsApp API transient failure HTTP ${httpStatus}`,
			providerCode: code,
			providerSubcode: subcode,
			responseBody,
		});
	}

	if (httpStatus >= 400) {
		return new WhatsAppSendError({
			httpStatus,
			kind: "permanent",
			message: `WhatsApp API permanent failure HTTP ${httpStatus}`,
			providerCode: code,
			providerSubcode: subcode,
			responseBody,
		});
	}

	return new WhatsAppSendError({
		httpStatus,
		kind: "uncertain",
		message: `WhatsApp API unexpected response HTTP ${httpStatus}`,
		providerCode: code,
		providerSubcode: subcode,
		responseBody,
	});
}
