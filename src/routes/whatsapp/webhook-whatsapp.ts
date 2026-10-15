/** biome-ignore-all lint/performance/noAwaitInLoops: <> */
/** biome-ignore-all lint/style/useDestructuring: <> */
/** biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: <> */
/** biome-ignore-all lint/suspicious/useAwait: <> */
/** biome-ignore-all assist/source/useSortedKeys: <> */

import { and, eq, gt, isNull, ne, sql } from "drizzle-orm";
import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";

import { db } from "../../db/connections";
import {
	autonomousTasks,
	conversations,
	messages,
	whatsappWebhookEvents,
} from "../../db/schema";
import { env } from "../../env";
import { whatsAppService } from "../../integrations/whatsapp/whatsapp-service";
import type { WhatsAppWebhookPayload } from "../../integrations/whatsapp/whatsapp-types";
import {
	PROCESS_BUTTON_REPLY_TASK,
	PROCESS_CONSULTANT_PREFERENCE_REPLY_TASK,
	PROCESS_CONSULTANT_SELECTION_TASK,
	PROCESS_INBOUND_MESSAGE_TASK,
	SEND_CONFIRMATION_REQUEST_TASK,
} from "../../services/conversations/autonomous-task-handlers";
import { isOptOutRequest } from "../../services/conversations/whatsapp-compliance";
import { leadIngestionService } from "../../services/leads/lead-ingestion";

const WHATSAPP_WEBHOOK_EVENT_LEASE_MS = 60_000;
const SCHEDULING_SLOT_BUTTON_ID = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;

async function recoverStaleProcessingWebhookEvents() {
	const now = new Date();

	await db
		.update(whatsappWebhookEvents)
		.set({
			lastError: "processing lease expired",
			leaseExpiresAt: null,
			status: "failed",
			updatedAt: now,
		})
		.where(
			and(
				eq(whatsappWebhookEvents.status, "processing"),
				sql`${whatsappWebhookEvents.leaseExpiresAt} IS NOT NULL AND ${whatsappWebhookEvents.leaseExpiresAt} <= ${now.toISOString()}`
			)
		);
}

async function claimWhatsAppWebhookEvent({
	externalId,
	phone,
	eventType,
	payload,
}: {
	externalId: string;
	phone?: string;
	eventType: "button_reply" | "text";
	payload: Record<string, unknown>;
}) {
	const now = new Date();
	const leaseExpiresAt = new Date(
		now.getTime() + WHATSAPP_WEBHOOK_EVENT_LEASE_MS
	);

	const reclaimValues = {
		lastError: null,
		leaseExpiresAt,
		payload,
		phone,
		status: "processing" as const,
		updatedAt: now,
	};

	const [insertedEvent] = await db
		.insert(whatsappWebhookEvents)
		.values({
			eventType,
			externalId,
			leaseExpiresAt,
			payload,
			phone,
			status: "processing",
		})
		.onConflictDoNothing()
		.returning();

	if (insertedEvent) {
		return { duplicate: false, event: insertedEvent };
	}

	const [existingEvent] = await db
		.select()
		.from(whatsappWebhookEvents)
		.where(eq(whatsappWebhookEvents.externalId, externalId))
		.limit(1);

	if (!existingEvent) {
		return { duplicate: false as const };
	}

	const canReclaim =
		existingEvent.status === "failed" ||
		(existingEvent.status === "processing" &&
			(!existingEvent.leaseExpiresAt || existingEvent.leaseExpiresAt <= now));

	if (canReclaim) {
		const [reclaimedEvent] = await db
			.update(whatsappWebhookEvents)
			.set(reclaimValues)
			.where(
				and(
					eq(whatsappWebhookEvents.externalId, externalId),
					eq(whatsappWebhookEvents.status, existingEvent.status)
				)
			)
			.returning();

		if (reclaimedEvent) {
			return { duplicate: false, event: reclaimedEvent };
		}
	}

	return { duplicate: true as const, event: existingEvent };
}

export async function enqueueTask({
	availableAt,
	conversationId,
	idempotencyKey,
	payload,
	preserveExisting = false,
	taskType,
	triggerMessageId,
}: {
	availableAt?: Date;
	conversationId: string;
	idempotencyKey: string;
	payload: Record<string, unknown>;
	preserveExisting?: boolean;
	taskType: string;
	triggerMessageId?: string;
}): Promise<boolean> {
	const taskInsert = db.insert(autonomousTasks).values({
		availableAt: availableAt ?? new Date(),
		conversationId,
		idempotencyKey,
		payload,
		taskType,
		triggerMessageId: triggerMessageId ?? null,
	});

	if (preserveExisting) {
		const [insertedTask] = await taskInsert
			.onConflictDoNothing({ target: autonomousTasks.idempotencyKey })
			.returning({ id: autonomousTasks.id });
		return Boolean(insertedTask);
	}

	await taskInsert.onConflictDoUpdate({
		set: {
			availableAt: availableAt ?? new Date(),
			attempts: 0,
			lastError: null,
			leaseExpiresAt: null,
			leaseToken: null,
			payload,
			status: "pending",
			updatedAt: new Date(),
		},
		setWhere: ne(autonomousTasks.status, "processing"),
		target: autonomousTasks.idempotencyKey,
	});
	return true;
}

async function extendOpenInboundBatch({
	batchCutoffAt,
	conversationId,
	now,
}: {
	batchCutoffAt: Date;
	conversationId: string;
	now: Date;
}) {
	const pendingTasks = await db
		.select({ id: autonomousTasks.id, payload: autonomousTasks.payload })
		.from(autonomousTasks)
		.where(
			and(
				eq(autonomousTasks.conversationId, conversationId),
				eq(autonomousTasks.taskType, PROCESS_INBOUND_MESSAGE_TASK),
				eq(autonomousTasks.status, "pending"),
				isNull(autonomousTasks.startedAt),
				gt(autonomousTasks.availableAt, now)
			)
		);

	for (const pendingTask of pendingTasks) {
		await db
			.update(autonomousTasks)
			.set({
				availableAt: batchCutoffAt,
				payload: {
					...pendingTask.payload,
					batchCutoffAt: batchCutoffAt.toISOString(),
				},
				updatedAt: now,
			})
			.where(
				and(
					eq(autonomousTasks.id, pendingTask.id),
					eq(autonomousTasks.status, "pending"),
					isNull(autonomousTasks.startedAt),
					gt(autonomousTasks.availableAt, now)
				)
			);
	}
}

export const webhookWhatsApp: FastifyPluginCallbackZod = (app, _opts, done) => {
	app.addContentTypeParser(
		"application/json",
		{ parseAs: "string" },
		(req, body, doneParsing) => {
			try {
				(req as unknown as { rawBody: string }).rawBody = body as string;

				const json = JSON.parse(body as string);

				doneParsing(null, json);
			} catch (err) {
				doneParsing(err as Error, undefined);
			}
		}
	);

	app.get("/webhooks/whatsapp", async (request, reply) => {
		const query = request.query as Record<string, string | undefined>;
		const mode = query["hub.mode"];
		const token = query["hub.verify_token"];
		const challenge = query["hub.challenge"];

		if (mode === "subscribe" && token === env.WHATSAPP_VERIFY_TOKEN) {
			request.log.info({
				event: "whatsapp_webhook_verified",
			});

			return reply
				.code(200)
				.type("text/plain")
				.send(challenge ?? "");
		}

		request.log.warn({
			event: "whatsapp_webhook_verification_failed",
			mode,
			tokenMatched: false,
		});

		return reply.code(403).send({
			error: "Forbidden",
		});
	});

	app.post("/webhooks/whatsapp", async (request, reply) => {
		await recoverStaleProcessingWebhookEvents();

		const signatureHeader = request.headers["x-hub-signature-256"] as
			| string
			| undefined;

		const rawBody =
			(request as unknown as { rawBody?: string }).rawBody ??
			JSON.stringify(request.body);

		if (!whatsAppService.verifySignature(rawBody, signatureHeader)) {
			request.log.warn({
				event: "whatsapp_webhook_invalid_signature",
			});

			return reply.code(401).send({
				error: "Invalid signature",
			});
		}

		const payload = request.body as WhatsAppWebhookPayload;

		if (payload.object !== "whatsapp_business_account" || !payload.entry) {
			return reply.code(200).send({
				status: "ignored",
			});
		}

		for (const entry of payload.entry) {
			if (!entry.changes) {
				continue;
			}

			for (const change of entry.changes) {
				const { value } = change;

				if (!value?.messages || value.messages.length === 0) {
					continue;
				}

				for (const message of value.messages) {
					const isTextMessage =
						message.type === "text" && Boolean(message.text?.body);

					const isButtonReply =
						message.type === "interactive" &&
						message.interactive?.type === "button_reply" &&
						Boolean(message.interactive.button_reply?.id);

					if (!(isTextMessage || isButtonReply)) {
						continue;
					}

					const phone = message.from;
					const externalId = message.id;
					const content = message.text?.body;
					const buttonId = message.interactive?.button_reply?.id;
					const eventType = isButtonReply ? "button_reply" : "text";

					const eventReceipt = await claimWhatsAppWebhookEvent({
						eventType,
						externalId,
						payload: { buttonId, content, message, phone },
						phone,
					});

					if (eventReceipt.duplicate || !eventReceipt.event) {
						continue;
					}

					const event = eventReceipt.event;

					try {
						const contact = value.contacts?.find((c) => c.wa_id === phone);

						const ingestionResult = await leadIngestionService.ingest({
							name: contact?.profile?.name,
							phone,
							source: "whatsapp",
						});

						const lead = ingestionResult.lead;

						let [conversation] = await db
							.select()
							.from(conversations)
							.where(
								and(
									eq(conversations.leadId, lead.id),
									eq(conversations.status, "active")
								)
							)
							.limit(1);

						if (!conversation) {
							[conversation] = await db
								.insert(conversations)
								.values({ leadId: lead.id })
								.returning();
						}

						await db
							.update(whatsappWebhookEvents)
							.set({ conversationId: conversation.id, updatedAt: new Date() })
							.where(eq(whatsappWebhookEvents.id, event.id));

						if (isButtonReply && buttonId) {
							/*
							 * Uma resposta interativa também é uma ação de entrada
							 * do cliente e renova a janela de atendimento.
							 */
							await db
								.update(conversations)
								.set({
									lastCustomerMessageAt: new Date(),
									updatedAt: new Date(),
								})
								.where(eq(conversations.id, conversation.id));

							// Determinar o tipo de tarefa baseado no prefixo do buttonId
							let taskType = PROCESS_BUTTON_REPLY_TASK;
							if (buttonId.startsWith("pref:")) {
								taskType = PROCESS_CONSULTANT_PREFERENCE_REPLY_TASK;
							} else if (buttonId.startsWith("consultant:")) {
								taskType = PROCESS_CONSULTANT_SELECTION_TASK;
							} else if (
								buttonId.startsWith("confirm:") ||
								buttonId.startsWith("cancel:")
							) {
								taskType = PROCESS_BUTTON_REPLY_TASK;
							} else if (SCHEDULING_SLOT_BUTTON_ID.test(buttonId)) {
								taskType = SEND_CONFIRMATION_REQUEST_TASK;
							}

							await enqueueTask({
								conversationId: conversation.id,
								idempotencyKey: `button-reply:${externalId}`,
								payload: {
									buttonId,
									eventExternalId: externalId,
									eventId: event.id,
									kind: "button_reply",
								},
								taskType,
							});
						} else if (content) {
							const [insertedMessage] = await db
								.insert(messages)
								.values({
									content,
									conversationId: conversation.id,
									externalId,
									role: "user",
								})
								.onConflictDoNothing()
								.returning();

							const inboundMessage =
								insertedMessage ??
								(
									await db
										.select()
										.from(messages)
										.where(eq(messages.externalId, externalId))
										.limit(1)
								)[0];

							await db
								.update(conversations)
								.set({
									lastCustomerMessageAt: new Date(),
									updatedAt: new Date(),
									...(isOptOutRequest(content) ? { optOutAt: new Date() } : {}),
								})
								.where(eq(conversations.id, conversation.id));

							if (!inboundMessage) {
								throw new Error("Inbound message not found");
							}

							const now = new Date();
							const batchCutoffAt = new Date(
								now.getTime() + env.MESSAGE_DEBOUNCE_MS
							);
							const insertedTask = await enqueueTask({
								availableAt: batchCutoffAt,
								conversationId: conversation.id,
								idempotencyKey: `inbound:${externalId}`,
								payload: {
									batchCutoffAt: batchCutoffAt.toISOString(),
									eventExternalId: externalId,
									eventId: event.id,
									kind: "text",
								},
								preserveExisting: true,
								taskType: PROCESS_INBOUND_MESSAGE_TASK,
								triggerMessageId: inboundMessage.id,
							});

							if (insertedTask) {
								await extendOpenInboundBatch({
									batchCutoffAt,
									conversationId: conversation.id,
									now,
								});
							}
						}
					} catch (err) {
						request.log.error(
							{
								err,
								event: "whatsapp_webhook_enqueue_failed",
								externalId,
								conversationId: undefined,
							},
							"Failed to durably enqueue WhatsApp event"
						);

						await db
							.update(whatsappWebhookEvents)
							.set({
								lastError: err instanceof Error ? err.message : String(err),
								leaseExpiresAt: null,
								status: "failed",
								updatedAt: new Date(),
							})
							.where(eq(whatsappWebhookEvents.id, event.id));
					}
				}
			}
		}

		return reply.code(200).send({
			status: "ok",
		});
	});

	done();
};
