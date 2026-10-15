import { env } from "../../env";
import {
	classifyWhatsAppHttpError,
	WhatsAppSendError,
} from "./whatsapp-errors";
import type {
	WhatsAppReplyButton,
	WhatsAppSendMessageResponse,
} from "./whatsapp-types";

export interface WhatsAppClientOptions {
	accessToken?: string;
	apiVersion?: string;
	phoneNumberId?: string;
	sendTimeoutMs?: number;
}

/**
 * Rejeita quando o sinal aborta. Corre junto com o fetch para liberar o
 * worker mesmo se a requisição ignorar o `AbortSignal`.
 */
function rejectOnAbort(signal: AbortSignal): Promise<never> {
	return new Promise((_, reject) => {
		signal.addEventListener("abort", () => reject(signal.reason), {
			once: true,
		});
	});
}

export class WhatsAppClient {
	private readonly accessToken: string;
	private readonly apiVersion: string;
	private readonly phoneNumberId: string;
	private readonly sendTimeoutMs: number;

	constructor(options?: WhatsAppClientOptions) {
		this.accessToken = options?.accessToken ?? env.WHATSAPP_ACCESS_TOKEN;
		const rawVersion = options?.apiVersion ?? env.WHATSAPP_GRAPH_API_VERSION;
		this.apiVersion = rawVersion.startsWith("v")
			? rawVersion
			: `v${rawVersion}`;
		this.phoneNumberId = options?.phoneNumberId ?? env.WHATSAPP_PHONE_NUMBER_ID;
		this.sendTimeoutMs = options?.sendTimeoutMs ?? env.WHATSAPP_SEND_TIMEOUT_MS;
	}

	private get messagesUrl(): string {
		return `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;
	}

	async sendTextMessage(
		to: string,
		text: string
	): Promise<WhatsAppSendMessageResponse> {
		return await this.postMessage(to, {
			messaging_product: "whatsapp",
			recipient_type: "individual",
			text: {
				body: text,
				preview_url: false,
			},
			to,
			type: "text",
		});
	}

	async sendReplyButtonsMessage(
		to: string,
		body: string,
		buttons: WhatsAppReplyButton[]
	): Promise<WhatsAppSendMessageResponse> {
		if (buttons.length < 1 || buttons.length > 3) {
			throw new Error(
				"WhatsApp reply buttons must contain between 1 and 3 buttons"
			);
		}

		return await this.postMessage(to, {
			interactive: {
				action: {
					buttons: buttons.map((button) => ({
						reply: { id: button.id, title: button.title },
						type: "reply",
					})),
				},
				body: { text: body },
				type: "button",
			},
			messaging_product: "whatsapp",
			recipient_type: "individual",
			to,
			type: "interactive",
		});
	}

	/**
	 * Envia para a Graph API com timeout. Timeout e erro de rede viram
	 * `uncertain`: a requisição pode ter chegado à Meta, então o outbox marca
	 * `unknown` e não reenvia.
	 */
	private async postMessage(
		to: string,
		payload: Record<string, unknown>
	): Promise<WhatsAppSendMessageResponse> {
		const signal = AbortSignal.timeout(this.sendTimeoutMs);

		try {
			return await Promise.race([
				this.request(to, payload, signal),
				rejectOnAbort(signal),
			]);
		} catch (error) {
			if (error instanceof WhatsAppSendError) {
				throw error;
			}
			const timedOut = signal.aborted;
			console.error(
				timedOut
					? `[WhatsAppClient] Send timed out after ${this.sendTimeoutMs}ms; delivery is uncertain`
					: "[WhatsAppClient] Network error when sending message:",
				error
			);
			// biome-ignore lint/style/useErrorCause: cause is forwarded to ErrorOptions by WhatsAppSendError
			throw new WhatsAppSendError({
				cause: error,
				kind: "uncertain",
				message: timedOut
					? `WhatsApp send timed out after ${this.sendTimeoutMs}ms`
					: "Failed to send WhatsApp message due to network error",
			});
		}
	}

	private async request(
		to: string,
		payload: Record<string, unknown>,
		signal: AbortSignal
	): Promise<WhatsAppSendMessageResponse> {
		const response = await fetch(this.messagesUrl, {
			body: JSON.stringify(payload),
			headers: {
				Authorization: `Bearer ${this.accessToken}`,
				"Content-Type": "application/json",
			},
			method: "POST",
			signal,
		});

		if (!response.ok) {
			const errorData = await response.text();
			console.error("[WhatsAppClient] Error sending message:", {
				errorData,
				status: response.status,
				statusText: response.statusText,
				to,
			});
			throw classifyWhatsAppHttpError(response.status, errorData);
		}

		return (await response.json()) as WhatsAppSendMessageResponse;
	}
}
