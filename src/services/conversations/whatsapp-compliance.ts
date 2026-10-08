import { eq } from "drizzle-orm";

import { db } from "../../db/connections";
import { conversations } from "../../db/schema";

export const WHATSAPP_CUSTOMER_WINDOW_MS = 24 * 60 * 60 * 1000;

// Kept deliberately conservative: it only matches an explicit request to stop.
const OPT_OUT_PATTERN =
	/(?:^|\s)(?:pare|parar|stop|unsubscribe|cancelar\s+contato|nao\s+quero(?:\s+(?:mais|receber))?|nao\s+me\s+mande(?:\s+mensagens)?|remova\s+meu\s+numero)(?:[!.?,\s]|$)/i;

export function isOptOutRequest(content: string): boolean {
	const normalized = content
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.trim();
	return OPT_OUT_PATTERN.test(normalized);
}

export type WhatsAppOutboundKind = "free_form" | "approved_template";

export function evaluateWhatsAppOutbound({
	at = new Date(),
	hasConsent = false,
	kind,
	lastCustomerMessageAt,
	optOutAt,
}: {
	at?: Date;
	hasConsent?: boolean;
	kind: WhatsAppOutboundKind;
	lastCustomerMessageAt: Date | null;
	optOutAt: Date | null;
}): { allowed: boolean; reason?: string } {
	if (optOutAt) {
		return { allowed: false, reason: "contact_opted_out" };
	}
	const inCustomerWindow =
		lastCustomerMessageAt !== null &&
		at.getTime() - lastCustomerMessageAt.getTime() <=
			WHATSAPP_CUSTOMER_WINDOW_MS;
	if (inCustomerWindow) {
		return { allowed: true };
	}
	if (!hasConsent) {
		return { allowed: false, reason: "missing_proactive_consent" };
	}
	if (kind !== "approved_template") {
		return {
			allowed: false,
			reason: "customer_window_closed_template_required",
		};
	}
	return { allowed: true };
}

export async function assertWhatsAppOutboundAllowed({
	conversationId,
	leadId,
	kind = "free_form",
}: {
	conversationId: string;
	leadId: string;
	kind?: WhatsAppOutboundKind;
}): Promise<void> {
	const [conversation] = await db
		.select({
			lastCustomerMessageAt: conversations.lastCustomerMessageAt,
			optOutAt: conversations.optOutAt,
		})
		.from(conversations)
		.where(eq(conversations.id, conversationId))
		.limit(1);
	if (!conversation) {
		throw new Error("Conversation not found for WhatsApp compliance");
	}
	// There is deliberately no inferred consent field. A phone number, lead or ad
	// origin is not evidence of permission for a new business-initiated contact.
	const decision = evaluateWhatsAppOutbound({ ...conversation, kind });
	if (!decision.allowed) {
		console.warn("[WhatsAppCompliance] outbound blocked", {
			conversationId,
			leadId,
			messageType: kind,
			reason: decision.reason,
			timestamp: new Date().toISOString(),
		});
		throw new Error(`WhatsApp outbound blocked: ${decision.reason}`);
	}
}
