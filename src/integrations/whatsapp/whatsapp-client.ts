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
}

export class WhatsAppClient {
	private readonly accessToken: string;
	private readonly apiVersion: string;
	private readonly phoneNumberId: string;

	constructor(options?: WhatsAppClientOptions) {
		this.accessToken = options?.accessToken ?? env.WHATSAPP_ACCESS_TOKEN;
		const rawVersion = options?.apiVersion ?? env.WHATSAPP_GRAPH_API_VERSION;
		this.apiVersion = rawVersion.startsWith("v")
			? rawVersion
			: `v${rawVersion}`;
		this.phoneNumberId = options?.phoneNumberId ?? env.WHATSAPP_PHONE_NUMBER_ID;
	}

	private get messagesUrl(): string {
		return `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;
	}

	async sendTextMessage(
		to: string,
		text: string
	): Promise<WhatsAppSendMessageResponse> {
		const url = this.messagesUrl;

		const payload = {
			messaging_product: "whatsapp",
			recipient_type: "individual",
			text: {
				body: text,
				preview_url: false,
			},
			to,
			type: "text",
		};

		try {
			const response = await fetch(url, {
				body: JSON.stringify(payload),
				headers: {
					Authorization: `Bearer ${this.accessToken}`,
					"Content-Type": "application/json",
				},
				method: "POST",
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

			const data = (await response.json()) as WhatsAppSendMessageResponse;
			return data;
		} catch (error) {
			if (error instanceof WhatsAppSendError) {
				throw error;
			}
			console.error(
				"[WhatsAppClient] Network error when sending message:",
				error
			);
			// biome-ignore lint/style/useErrorCause: cause is forwarded to ErrorOptions by WhatsAppSendError
			throw new WhatsAppSendError({
				cause: error,
				kind: "uncertain",
				message: "Failed to send WhatsApp message due to network error",
			});
		}
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

		const url = this.messagesUrl;
		const payload = {
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
		};

		try {
			const response = await fetch(url, {
				body: JSON.stringify(payload),
				headers: {
					Authorization: `Bearer ${this.accessToken}`,
					"Content-Type": "application/json",
				},
				method: "POST",
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
		} catch (error) {
			if (error instanceof WhatsAppSendError) {
				throw error;
			}
			console.error(
				"[WhatsAppClient] Network error when sending message:",
				error
			);
			// biome-ignore lint/style/useErrorCause: cause is forwarded to ErrorOptions by WhatsAppSendError
			throw new WhatsAppSendError({
				cause: error,
				kind: "uncertain",
				message: "Failed to send WhatsApp message due to network error",
			});
		}
	}
}
