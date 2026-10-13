/** biome-ignore-all lint/style/useFilenamingConvention: <> */
/** biome-ignore-all assist/source/useSortedKeys: <> */
/** biome-ignore-all lint/performance/noAwaitInLoops: <> */

import { randomUUID } from "node:crypto";
import type { InferSelectModel } from "drizzle-orm";
import { and, eq, sql } from "drizzle-orm";

import { db } from "../../db/connections";
import { leads, messages, outboundMessages } from "../../db/schema";
import { WhatsAppSendError } from "../../integrations/whatsapp/whatsapp-errors";
import { whatsAppService } from "../../integrations/whatsapp/whatsapp-service";
import type { WhatsAppReplyButton } from "../../integrations/whatsapp/whatsapp-types";
import { computeRetryBackoffMs } from "../../utils/retry-backoff";
import { assertWhatsAppOutboundAllowed } from "../conversations/whatsapp-compliance";

export type OutboundMessage = InferSelectModel<typeof outboundMessages>;

export type OutboundMessagePayload =
	| { kind: "text"; text: string }
	| { body: string; buttons: WhatsAppReplyButton[]; kind: "buttons" };

export const DEFAULT_OUTBOUND_LEASE_MS = 60_000;

export interface OutboundSender {
	sendReplyButtonsMessage: (
		to: string,
		body: string,
		buttons: WhatsAppReplyButton[]
	) => Promise<{ messages: Array<{ id: string }> }>;
	sendTextMessage: (
		to: string,
		text: string
	) => Promise<{ messages: Array<{ id: string }> }>;
}

export type OutboundExecutionResult =
	| { status: "idle" }
	| { leaseLost: true; status: "lease_lost"; messageId: string }
	| { status: "sent"; messageId: string; providerMessageId?: string }
	| { status: "retry_scheduled"; messageId: string; error: string }
	| { messageId: string; error: string; status: "failed" | "unknown" };

export async function enqueueOutboundMessage({
	conversationId,
	eventId,
	idempotencyKey,
	leadId,
	messageId,
	payload,
	maxAttempts,
}: {
	conversationId: string;
	eventId?: string;
	idempotencyKey: string;
	leadId?: string;
	messageId?: string;
	payload: OutboundMessagePayload;
	maxAttempts?: number;
}): Promise<OutboundMessage | undefined> {
	const [inserted] = await db
		.insert(outboundMessages)
		.values({
			conversationId,
			eventId: eventId ?? null,
			idempotencyKey,
			leadId: leadId ?? null,
			maxAttempts: maxAttempts ?? 5,
			messageId: messageId ?? null,
			messageType: payload.kind,
			payload: payload as unknown as Record<string, unknown>,
		})
		.onConflictDoNothing()
		.returning();

	if (inserted) {
		return inserted;
	}

	const [existing] = await db
		.select()
		.from(outboundMessages)
		.where(eq(outboundMessages.idempotencyKey, idempotencyKey))
		.limit(1);

	return existing;
}

async function claimNextOutboundMessage({
	conversationId,
	leaseMs,
}: {
	conversationId?: string;
	leaseMs: number;
}): Promise<OutboundMessage | undefined> {
	const leaseToken = randomUUID();
	const leaseExpiresAt = new Date(Date.now() + leaseMs);

	const conversationFilter = conversationId
		? sql`AND msg."conversationId" = ${conversationId}`
		: sql``;

	const rows = (await db.execute(
		sql`
    WITH candidate AS (
      SELECT msg."id"
      FROM "outbound_messages" AS msg
      WHERE msg."status" = 'pending'
        AND msg."availableAt" <= now()
        AND msg."attempts" < msg."maxAttempts"
        ${conversationFilter}
      ORDER BY msg."availableAt", msg."createdAt"
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE "outbound_messages" AS msg
    SET
      "status" = 'sending',
      "attempts" = msg."attempts" + 1,
      "leaseToken" = ${leaseToken},
      "leaseExpiresAt" = ${leaseExpiresAt.toISOString()},
      "updatedAt" = now()
    FROM candidate
    WHERE msg."id" = candidate."id"
    RETURNING msg.*
  `
	)) as OutboundMessage[];

	return rows[0] as OutboundMessage | undefined;
}

export async function renewOutboundLease({
	messageId,
	leaseToken,
	leaseMs = DEFAULT_OUTBOUND_LEASE_MS,
}: {
	messageId: string;
	leaseToken: string;
	leaseMs?: number;
}): Promise<boolean> {
	const [renewed] = await db
		.update(outboundMessages)
		.set({
			leaseExpiresAt: new Date(Date.now() + leaseMs),
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(outboundMessages.id, messageId),
				eq(outboundMessages.status, "sending"),
				eq(outboundMessages.leaseToken, leaseToken)
			)
		)
		.returning({ id: outboundMessages.id });

	return Boolean(renewed);
}

async function markOutboundSent({
	messageId,
	leaseToken,
	providerMessageId,
}: {
	messageId: string;
	leaseToken: string;
	providerMessageId?: string;
}): Promise<boolean> {
	const [updated] = await db
		.update(outboundMessages)
		.set({
			lastError: null,
			leaseExpiresAt: null,
			leaseToken: null,
			providerMessageId: providerMessageId ?? null,
			sentAt: new Date(),
			status: "sent",
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(outboundMessages.id, messageId),
				eq(outboundMessages.status, "sending"),
				eq(outboundMessages.leaseToken, leaseToken)
			)
		)
		.returning({ id: outboundMessages.id });

	return Boolean(updated);
}

async function markOutboundTerminal({
	messageId,
	leaseToken,
	status,
	error,
}: {
	messageId: string;
	leaseToken: string;
	status: "failed" | "unknown";
	error: string;
}): Promise<boolean> {
	const [updated] = await db
		.update(outboundMessages)
		.set({
			lastError: error,
			leaseExpiresAt: null,
			leaseToken: null,
			status,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(outboundMessages.id, messageId),
				eq(outboundMessages.status, "sending"),
				eq(outboundMessages.leaseToken, leaseToken)
			)
		)
		.returning({ id: outboundMessages.id });

	return Boolean(updated);
}

async function markOutboundRetryOrFail({
	message,
	leaseToken,
	error,
}: {
	message: OutboundMessage;
	leaseToken: string;
	error: unknown;
}): Promise<OutboundExecutionResult> {
	const errorMessage = error instanceof Error ? error.message : String(error);
	const shouldRetry = message.attempts < message.maxAttempts;
	const now = new Date();

	const [updated] = await db
		.update(outboundMessages)
		.set({
			availableAt: shouldRetry
				? new Date(now.getTime() + computeRetryBackoffMs(message.attempts))
				: message.availableAt,
			lastError: errorMessage,
			leaseExpiresAt: null,
			leaseToken: null,
			status: shouldRetry ? "pending" : "failed",
			updatedAt: now,
		})
		.where(
			and(
				eq(outboundMessages.id, message.id),
				eq(outboundMessages.status, "sending"),
				eq(outboundMessages.leaseToken, leaseToken)
			)
		)
		.returning({ id: outboundMessages.id });

	if (!updated) {
		return { leaseLost: true, messageId: message.id, status: "lease_lost" };
	}

	if (shouldRetry) {
		return {
			error: errorMessage,
			messageId: message.id,
			status: "retry_scheduled",
		};
	}

	return { error: errorMessage, messageId: message.id, status: "failed" };
}

/**
 * Mensagens presas em `sending` com lease expirado têm resultado incerto:
 * podem já ter sido entregues. Marca como `unknown` em vez de reenviar, para
 * nunca duplicar uma resposta ao cliente.
 */
export async function recoverStaleOutboundMessages({
	now = new Date(),
}: {
	now?: Date;
} = {}): Promise<number> {
	const rows = (await db.execute(
		sql`
    UPDATE "outbound_messages"
    SET
      "status" = 'unknown',
      "lastError" = COALESCE("lastError", 'sending lease expired'),
      "leaseToken" = NULL,
      "leaseExpiresAt" = NULL,
      "updatedAt" = now()
    WHERE "status" = 'sending'
      AND "leaseExpiresAt" IS NOT NULL
      AND "leaseExpiresAt" <= ${now.toISOString()}
    RETURNING "id"
  `
	)) as { id: string }[];

	return rows.length;
}

export async function executeNextOutboundMessage({
	conversationId,
	leaseMs = DEFAULT_OUTBOUND_LEASE_MS,
	sender = whatsAppService,
}: {
	conversationId?: string;
	leaseMs?: number;
	sender?: OutboundSender;
} = {}): Promise<OutboundExecutionResult> {
	const message = await claimNextOutboundMessage({ conversationId, leaseMs });

	if (!message?.leaseToken) {
		return { status: "idle" };
	}

	const { leaseToken } = message;

	if (!message.leadId) {
		await markOutboundTerminal({
			error: "outbound message has no lead",
			leaseToken,
			messageId: message.id,
			status: "failed",
		});
		return {
			error: "outbound message has no lead",
			messageId: message.id,
			status: "failed",
		};
	}

	const [lead] = await db
		.select({ phone: leads.phone })
		.from(leads)
		.where(eq(leads.id, message.leadId))
		.limit(1);

	if (!lead) {
		await markOutboundTerminal({
			error: "lead not found for outbound message",
			leaseToken,
			messageId: message.id,
			status: "failed",
		});
		return {
			error: "lead not found for outbound message",
			messageId: message.id,
			status: "failed",
		};
	}

	try {
		await assertWhatsAppOutboundAllowed({
			conversationId: message.conversationId,
			leadId: message.leadId,
		});
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		await markOutboundTerminal({
			error: errorMessage,
			leaseToken,
			messageId: message.id,
			status: "failed",
		});
		return { error: errorMessage, messageId: message.id, status: "failed" };
	}

	const payload = message.payload as unknown as OutboundMessagePayload;

	try {
		const response =
			payload.kind === "buttons"
				? await sender.sendReplyButtonsMessage(
						lead.phone,
						payload.body,
						payload.buttons
					)
				: await sender.sendTextMessage(lead.phone, payload.text);

		const providerMessageId = response.messages[0]?.id;

		const recorded = await markOutboundSent({
			leaseToken,
			messageId: message.id,
			providerMessageId,
		});

		if (!recorded) {
			return { leaseLost: true, messageId: message.id, status: "lease_lost" };
		}

		if (providerMessageId && message.messageId) {
			await db
				.update(messages)
				.set({ externalId: providerMessageId })
				.where(eq(messages.id, message.messageId));
		}

		return {
			messageId: message.id,
			providerMessageId,
			status: "sent",
		};
	} catch (error) {
		if (error instanceof WhatsAppSendError) {
			if (error.uncertain) {
				await markOutboundTerminal({
					error: error.message,
					leaseToken,
					messageId: message.id,
					status: "unknown",
				});
				return {
					error: error.message,
					messageId: message.id,
					status: "unknown",
				};
			}

			if (!error.retryable) {
				await markOutboundTerminal({
					error: error.message,
					leaseToken,
					messageId: message.id,
					status: "failed",
				});
				return {
					error: error.message,
					messageId: message.id,
					status: "failed",
				};
			}
		}

		return await markOutboundRetryOrFail({ error, leaseToken, message });
	}
}

export async function runOutboundMessagesUntilIdle({
	conversationId,
	leaseMs = DEFAULT_OUTBOUND_LEASE_MS,
	maxIterations = 200,
	sender = whatsAppService,
}: {
	conversationId?: string;
	leaseMs?: number;
	maxIterations?: number;
	sender?: OutboundSender;
} = {}): Promise<number> {
	await recoverStaleOutboundMessages();

	let processed = 0;

	for (let iteration = 0; iteration < maxIterations; iteration += 1) {
		const result = await executeNextOutboundMessage({
			conversationId,
			leaseMs,
			sender,
		});

		if (result.status === "idle") {
			break;
		}

		processed += 1;
	}

	return processed;
}
