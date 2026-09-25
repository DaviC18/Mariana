import { env } from "../../env";
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
		this.apiVersion = options?.apiVersion ?? env.WHATSAPP_GRAPH_API_VERSION;
		this.phoneNumberId = options?.phoneNumberId ?? env.WHATSAPP_PHONE_NUMBER_ID;
	}

	async sendTextMessage(
		to: string,
		text: string
	): Promise<WhatsAppSendMessageResponse> {
		const url = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;

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
				throw new Error(
					`WhatsApp API HTTP ${response.status}: ${response.statusText}`
				);
			}

			const data = (await response.json()) as WhatsAppSendMessageResponse;
			return data;
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("WhatsApp API")) {
				throw error;
			}
			console.error(
				"[WhatsAppClient] Network error when sending message:",
				error
			);
			throw new Error("Failed to send WhatsApp message due to network error", {
				cause: error,
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

		const url =
			"https://graph.facebook.com/" +
			this.apiVersion +
			"/" +
			this.phoneNumberId +
			"/messages";
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
				throw new Error(
					`WhatsApp API HTTP ${response.status}: ${response.statusText}`
				);
			}

			return (await response.json()) as WhatsAppSendMessageResponse;
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("WhatsApp API")) {
				throw error;
			}
			console.error(
				"[WhatsAppClient] Network error when sending message:",
				error
			);
			throw new Error("Failed to send WhatsApp message due to network error", {
				cause: error,
			});
		}
	}
}
