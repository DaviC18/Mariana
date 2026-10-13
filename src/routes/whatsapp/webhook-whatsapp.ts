/** biome-ignore-all lint/performance/noAwaitInLoops: <> */
/** biome-ignore-all lint/style/useDestructuring: <> */
/** biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: <> */
/** biome-ignore-all lint/suspicious/useAwait: <> */
/** biome-ignore-all assist/source/useSortedKeys: <> */

import { and, eq, ne, sql } from "drizzle-orm";
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
	PROCESS_INBOUND_MESSAGE_TASK,
} from "../../services/conversations/autonomous-task-handlers";
import { isOptOutRequest } from "../../services/conversations/whatsapp-compliance";
import { leadIngestionService } from "../../services/leads/lead-ingestion";

const WHATSAPP_WEBHOOK_EVENT_LEASE_MS = 60_000;

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

async function enqueueTask({
	conversationId,
	idempotencyKey,
	payload,
	taskType,
	triggerMessageId,
}: {
	conversationId: string;
	idempotencyKey: string;
	payload: Record<string, unknown>;
	taskType: string;
	triggerMessageId?: string;
}) {
	await db
		.insert(autonomousTasks)
		.values({
			conversationId,
			idempotencyKey,
			payload,
			taskType,
			triggerMessageId: triggerMessageId ?? null,
		})
		.onConflictDoUpdate({
			set: {
				availableAt: new Date(),
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
			token,
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

							await enqueueTask({
								conversationId: conversation.id,
								idempotencyKey: `button-reply:${externalId}`,
								payload: {
									buttonId,
									eventExternalId: externalId,
									eventId: event.id,
									kind: "button_reply",
								},
								taskType: PROCESS_BUTTON_REPLY_TASK,
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

							await enqueueTask({
								conversationId: conversation.id,
								idempotencyKey: `inbound:${externalId}`,
								payload: {
									eventExternalId: externalId,
									eventId: event.id,
									kind: "text",
								},
								taskType: PROCESS_INBOUND_MESSAGE_TASK,
								triggerMessageId: inboundMessage?.id,
							});
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
