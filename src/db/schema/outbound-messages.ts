/** biome-ignore-all assist/source/useSortedKeys: <> */
import {
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";

import { conversations } from "./conversations";
import { leads } from "./leads";
import { messages } from "./messages";
import { whatsappWebhookEvents } from "./whatsapp-webhook-events";

// Estado do outbox de mensagens de saída.
//
// - pending: persistida, aguardando envio.
// - sending: reclamada por um worker (lease ativo).
// - sent: entrega confirmada pela API do WhatsApp.
// - failed: falha permanente, sem novas tentativas automáticas.
// - unknown: resultado incerto (ex.: falha de rede após o envio). Não é
//   reenviada automaticamente para evitar respostas duplicadas ao cliente.
export const outboundMessageStatus = pgEnum("outbound_message_status", [
	"pending",
	"sending",
	"sent",
	"failed",
	"unknown",
]);

export const outboundMessages = pgTable(
	"outbound_messages",
	{
		id: uuid().primaryKey().defaultRandom(),

		// Chave estável da operação lógica. Retries não geram nova chave.
		idempotencyKey: text().notNull().unique(),

		conversationId: uuid()
			.notNull()
			.references(() => conversations.id, { onDelete: "cascade" }),
		leadId: uuid().references(() => leads.id, { onDelete: "set null" }),

		// Evento de entrada que originou a resposta (quando aplicável).
		eventId: uuid().references(() => whatsappWebhookEvents.id, {
			onDelete: "set null",
		}),

		// Mensagem assistente associada, usada para gravar o WAMID de saída.
		messageId: uuid().references(() => messages.id, { onDelete: "set null" }),

		messageType: text().notNull(),
		payload: jsonb().$type<Record<string, unknown>>().notNull().default({}),

		status: outboundMessageStatus().notNull().default("pending"),
		attempts: integer().notNull().default(0),
		maxAttempts: integer().notNull().default(5),

		availableAt: timestamp({ withTimezone: true }).notNull().defaultNow(),

		leaseToken: uuid(),
		leaseExpiresAt: timestamp({ withTimezone: true }),

		providerMessageId: text(),
		lastError: text(),

		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		sentAt: timestamp({ withTimezone: true }),
	},
	(table) => ({
		conversationCreatedAtIdx: index(
			"outbound_messages_conversation_created_at_idx"
		).on(table.conversationId, table.createdAt),
		statusAvailableAtIdx: index("outbound_messages_status_available_at_idx").on(
			table.status,
			table.availableAt
		),
		statusLeaseExpiresAtIdx: index(
			"outbound_messages_status_lease_expires_at_idx"
		).on(table.status, table.leaseExpiresAt),
	})
);
