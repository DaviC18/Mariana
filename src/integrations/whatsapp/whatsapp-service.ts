import { env } from "../../env";
import { verifyWebhookSignature } from "../../utils/verify-webhook-signature";
import { WhatsAppClient } from "./whatsapp-client";
import type {
	WhatsAppReplyButton,
	WhatsAppSendMessageResponse,
} from "./whatsapp-types";

export class WhatsAppService {
	private readonly client: WhatsAppClient;
	private readonly appSecret: string;

	constructor(client?: WhatsAppClient, appSecret?: string) {
		this.client = client ?? new WhatsAppClient();
		this.appSecret = appSecret ?? env.WHATSAPP_APP_SECRET;
	}

	async sendTextMessage(
		to: string,
		text: string
	): Promise<WhatsAppSendMessageResponse> {
		return await this.client.sendTextMessage(to, text);
	}

	async sendReplyButtonsMessage(
		to: string,
		body: string,
		buttons: WhatsAppReplyButton[]
	): Promise<WhatsAppSendMessageResponse> {
		return await this.client.sendReplyButtonsMessage(to, body, buttons);
	}

	verifySignature(
		rawBody: string | Buffer,
		signatureHeader: string | undefined
	): boolean {
		return verifyWebhookSignature({
			rawBody,
			secret: this.appSecret,
			signatureHeader,
		});
	}
}

export const whatsAppService = new WhatsAppService();
