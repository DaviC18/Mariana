import crypto from "node:crypto";
import { env } from "../../env";
import { WhatsAppClient } from "./whatsapp-client";
import type { WhatsAppSendMessageResponse } from "./whatsapp-types";

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

	verifySignature(
		rawBody: string | Buffer,
		signatureHeader: string | undefined
	): boolean {
		if (!signatureHeader?.startsWith("sha256=")) {
			return false;
		}

		const signature = signatureHeader.slice("sha256=".length);
		const expectedSignature = crypto
			.createHmac("sha256", this.appSecret)
			.update(rawBody)
			.digest("hex");

		if (signature.length !== expectedSignature.length) {
			return false;
		}

		try {
			return crypto.timingSafeEqual(
				Buffer.from(signature, "hex"),
				Buffer.from(expectedSignature, "hex")
			);
		} catch {
			return false;
		}
	}
}

export const whatsAppService = new WhatsAppService();
