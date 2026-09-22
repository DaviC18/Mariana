export interface WhatsAppWebhookVerificationQuery {
	"hub.challenge"?: string;
	"hub.mode"?: string;
	"hub.verify_token"?: string;
}

export interface WhatsAppProfile {
	name?: string;
}

export interface WhatsAppContact {
	profile?: WhatsAppProfile;
	wa_id: string;
}

export interface WhatsAppTextMessage {
	body: string;
}

export interface WhatsAppMessage {
	from: string;
	id: string;
	text?: WhatsAppTextMessage;
	timestamp: string;
	type: string;
}

export interface WhatsAppStatus {
	id: string;
	recipient_id: string;
	status: string;
	timestamp: string;
}

export interface WhatsAppValue {
	contacts?: WhatsAppContact[];
	messages?: WhatsAppMessage[];
	messaging_product: string;
	metadata: {
		display_phone_number: string;
		phone_number_id: string;
	};
	statuses?: WhatsAppStatus[];
}

export interface WhatsAppChange {
	field: string;
	value: WhatsAppValue;
}

export interface WhatsAppEntry {
	changes: WhatsAppChange[];
	id: string;
}

export interface WhatsAppWebhookPayload {
	entry?: WhatsAppEntry[];
	object: string;
}

export interface SendTextMessageInput {
	text: string;
	to: string;
}

export interface WhatsAppSendMessageResponse {
	contacts: Array<{
		input: string;
		wa_id: string;
	}>;
	messages: Array<{
		id: string;
	}>;
	messaging_product: string;
}
