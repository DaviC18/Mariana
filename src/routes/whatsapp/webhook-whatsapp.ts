/** biome-ignore-all lint/performance/noAwaitInLoops: <> */
/** biome-ignore-all lint/style/useDestructuring: <> */
/** biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: <> */
/** biome-ignore-all lint/suspicious/useAwait: <> */
/** biome-ignore-all assist/source/useSortedKeys: <> */

import { and, eq, sql } from "drizzle-orm";
import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import { db } from "../../db/connections";
import {
	conversations,
	messages,
	whatsappWebhookEvents,
} from "../../db/schema";
import { env } from "../../env";
import { whatsAppService } from "../../integrations/whatsapp/whatsapp-service";
import type { WhatsAppWebhookPayload } from "../../integrations/whatsapp/whatsapp-types";
import { SchedulingCancellationService } from "../../services/calendar/scheduling-cancellation-service";
import { SchedulingChoiceService } from "../../services/calendar/scheduling-choice-service";
import { SchedulingConfirmationOrchestrator } from "../../services/calendar/scheduling-confirmation-orchestrator";
import { SchedulingConfirmationService } from "../../services/calendar/scheduling-confirmation-service";
import { buildWhatsAppSchedulingOffer } from "../../services/calendar/scheduling-offer-service";
import { receiveCustomerMessage } from "../../services/conversations/receive-customer-message";
import { assertWhatsAppOutboundAllowed } from "../../services/conversations/whatsapp-compliance";
import { leadIngestionService } from "../../services/leads/lead-ingestion";
import { formatSlotDate } from "../../utils/date-formatter";

const schedulingChoiceService = new SchedulingChoiceService();

const schedulingConfirmationService = new SchedulingConfirmationService();

const schedulingConfirmationOrchestrator =
	new SchedulingConfirmationOrchestrator();

const schedulingCancellationService = new SchedulingCancellationService();

const WHATSAPP_WEBHOOK_EVENT_LEASE_MS = 60_000;

async function sendCompliantText({
	conversationId,
	leadId,
	text,
	to,
}: {
	conversationId: string;
	leadId: string;
	text: string;
	to: string;
}) {
	await assertWhatsAppOutboundAllowed({ conversationId, leadId });
	return await whatsAppService.sendTextMessage(to, text);
}

async function sendCompliantButtons({
	body,
	buttons,
	conversationId,
	leadId,
	to,
}: {
	body: string;
	buttons: Parameters<typeof whatsAppService.sendReplyButtonsMessage>[2];
	conversationId: string;
	leadId: string;
	to: string;
}) {
	await assertWhatsAppOutboundAllowed({ conversationId, leadId });
	return await whatsAppService.sendReplyButtonsMessage(to, body, buttons);
}

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
		return {
			duplicate: false,
			event: insertedEvent,
		};
	}

	const [existingEvent] = await db
		.select()
		.from(whatsappWebhookEvents)
		.where(eq(whatsappWebhookEvents.externalId, externalId))
		.limit(1);

	if (!existingEvent) {
		return {
			duplicate: false,
		};
	}

	if (existingEvent.status === "processed") {
		return {
			duplicate: true,
			event: existingEvent,
		};
	}

	if (existingEvent.status === "failed") {
		const [reclaimedEvent] = await db
			.update(whatsappWebhookEvents)
			.set({
				lastError: null,
				leaseExpiresAt,
				payload,
				phone,
				status: "processing",
				updatedAt: now,
			})
			.where(
				and(
					eq(whatsappWebhookEvents.externalId, externalId),
					eq(whatsappWebhookEvents.status, "failed")
				)
			)
			.returning();

		if (reclaimedEvent) {
			return {
				duplicate: false,
				event: reclaimedEvent,
			};
		}
	}

	if (existingEvent.status === "processing") {
		if (!existingEvent.leaseExpiresAt || existingEvent.leaseExpiresAt > now) {
			return {
				duplicate: true,
				event: existingEvent,
			};
		}

		const [reclaimedEvent] = await db
			.update(whatsappWebhookEvents)
			.set({
				lastError: null,
				leaseExpiresAt,
				payload,
				phone,
				status: "processing",
				updatedAt: now,
			})
			.where(
				and(
					eq(whatsappWebhookEvents.externalId, externalId),
					eq(whatsappWebhookEvents.status, "processing"),
					sql`${whatsappWebhookEvents.leaseExpiresAt} IS NOT NULL AND ${whatsappWebhookEvents.leaseExpiresAt} <= ${now.toISOString()}`
				)
			)
			.returning();

		if (reclaimedEvent) {
			return {
				duplicate: false,
				event: reclaimedEvent,
			};
		}
	}

	return {
		duplicate: true,
		event: existingEvent,
	};
}

async function markWhatsAppWebhookEventProcessed(
	event: typeof whatsappWebhookEvents.$inferSelect
) {
	if (!event.leaseExpiresAt) {
		return;
	}

	await db
		.update(whatsappWebhookEvents)
		.set({
			lastError: null,
			leaseExpiresAt: null,
			status: "processed",
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(whatsappWebhookEvents.id, event.id),
				eq(whatsappWebhookEvents.status, "processing"),
				eq(whatsappWebhookEvents.leaseExpiresAt, event.leaseExpiresAt)
			)
		);
}

async function markWhatsAppWebhookEventFailed(
	event: typeof whatsappWebhookEvents.$inferSelect,
	reason: string
) {
	if (!event.leaseExpiresAt) {
		return;
	}

	const [existingEvent] = await db
		.select()
		.from(whatsappWebhookEvents)
		.where(
			and(
				eq(whatsappWebhookEvents.id, event.id),
				eq(whatsappWebhookEvents.status, "processing"),
				eq(whatsappWebhookEvents.leaseExpiresAt, event.leaseExpiresAt)
			)
		)
		.limit(1);

	const nextPayload =
		typeof existingEvent?.payload === "object" && existingEvent?.payload
			? { ...(existingEvent.payload as Record<string, unknown>), error: reason }
			: { error: reason };

	await db
		.update(whatsappWebhookEvents)
		.set({
			lastError: reason,
			leaseExpiresAt: null,
			payload: nextPayload,
			status: "failed",
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(whatsappWebhookEvents.id, event.id),
				eq(whatsappWebhookEvents.status, "processing"),
				eq(whatsappWebhookEvents.leaseExpiresAt, event.leaseExpiresAt)
			)
		);
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
						payload: {
							buttonId,
							content,
							message,
							phone,
						},
						phone,
					});

					if (eventReceipt.duplicate) {
						continue;
					}

					const contact = value.contacts?.find((c) => c.wa_id === phone);

					const profileName = contact?.profile?.name;

					const ingestionResult = await leadIngestionService.ingest({
						name: profileName,
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
							.values({
								leadId: lead.id,
							})
							.returning();
					}

					if (eventReceipt.event?.id) {
						await db
							.update(whatsappWebhookEvents)
							.set({
								conversationId: conversation.id,
								updatedAt: new Date(),
							})
							.where(eq(whatsappWebhookEvents.id, eventReceipt.event.id));
					}

					/*
					 * Fluxo determinístico de seleção,
					 * confirmação e cancelamento
					 * de horário.
					 *
					 * UUID puro:
					 *   representa um slot persistido.
					 *
					 * confirm:<slotId>:
					 *   confirma o horário selecionado.
					 *
					 * cancel:<slotId>:
					 *   rejeita a confirmação.
					 *
					 * Nenhum desses fluxos passa por
					 * receiveCustomerMessage/debounce/Gemini.
					 */

					if (buttonId) {
						try {
							// An interactive reply is also an inbound customer action and
							// therefore renews the customer-service window.
							await db
								.update(conversations)
								.set({
									lastCustomerMessageAt: new Date(),
									updatedAt: new Date(),
								})
								.where(eq(conversations.id, conversation.id));
							/*
							 * 1. Confirmação explícita
							 */
							if (buttonId.startsWith("confirm:")) {
								const confirmationResult =
									await schedulingConfirmationOrchestrator.execute({
										buttonId,
										conversationId: conversation.id,
										leadId: lead.id,
									});

								if (!confirmationResult.ok) {
									request.log.warn({
										event: "whatsapp_scheduling_confirmation_rejected",
										reason: confirmationResult.reason,
										buttonId,
										leadId: lead.id,
										conversationId: conversation.id,
										externalId,
									});

									if (eventReceipt.event?.id) {
										await markWhatsAppWebhookEventProcessed(eventReceipt.event);
									}

									continue;
								}

								if (confirmationResult.action === "confirm") {
									const { appointment, slot } = confirmationResult;

									const finalReply = `Agendamento confirmado para ${formatSlotDate(
										slot.startAt
									)} com ${slot.consultantName}.`;

									try {
										const sendResponse = await sendCompliantText({
											conversationId: conversation.id,
											leadId: lead.id,
											text: finalReply,
											to: lead.phone,
										});

										const outboundWamid = sendResponse.messages[0]?.id;

										request.log.info({
											event: "whatsapp_scheduling_confirmed",
											appointmentId: appointment.appointmentId,
											conversationId: conversation.id,
											leadId: lead.id,
											externalId,
											outboundWamid,
										});
									} catch (err) {
										request.log.error(
											{
												err,
												event: "whatsapp_scheduling_confirmation_send_failed",
												appointmentId: appointment.appointmentId,
												conversationId: conversation.id,
												leadId: lead.id,
												externalId,
											},
											"Failed to send scheduling confirmation to WhatsApp"
										);
									}
								}

								if (eventReceipt.event?.id) {
									await markWhatsAppWebhookEventProcessed(eventReceipt.event);
								}

								continue;
							}

							/*
							 * 2. Cliente não confirmou
							 *
							 * 2/3 slots:
							 *   reapresenta os mesmos slots.
							 *
							 * 1 slot:
							 *   fecha a sessão.
							 *
							 * Nenhuma nova consulta ao
							 * Google Calendar é feita aqui.
							 */
							if (buttonId.startsWith("cancel:")) {
								const cancellationResult =
									await schedulingCancellationService.resolveCancellation({
										buttonId,
										conversationId: conversation.id,
										leadId: lead.id,
									});

								if (!cancellationResult.ok) {
									request.log.warn({
										event: "whatsapp_scheduling_cancellation_rejected",
										reason: cancellationResult.reason,
										buttonId,
										leadId: lead.id,
										conversationId: conversation.id,
										externalId,
									});

									if (eventReceipt.event?.id) {
										await markWhatsAppWebhookEventProcessed(eventReceipt.event);
									}

									continue;
								}

								if (cancellationResult.action === "reoffer") {
									const buttons = cancellationResult.slots.map((slot) => ({
										id: slot.id,
										title: formatSlotDate(slot.startAt),
									}));

									try {
										const sendResponse = await sendCompliantButtons({
											body: "Tudo bem. Tenho estes horários disponíveis:",
											buttons,
											conversationId: conversation.id,
											leadId: lead.id,
											to: lead.phone,
										});

										const outboundWamid = sendResponse.messages[0]?.id;

										request.log.info({
											event: "whatsapp_scheduling_offer_reoffered",
											sessionId: cancellationResult.session.id,
											slotCount: cancellationResult.slots.length,
											leadId: lead.id,
											conversationId: conversation.id,
											externalId,
											outboundWamid,
										});
									} catch (err) {
										request.log.error(
											{
												err,
												event: "whatsapp_scheduling_reoffer_send_failed",
												leadId: lead.id,
												conversationId: conversation.id,
												sessionId: cancellationResult.session.id,
												externalId,
											},
											"Failed to reoffer scheduling slots to WhatsApp"
										);
									}

									if (eventReceipt.event?.id) {
										await markWhatsAppWebhookEventProcessed(eventReceipt.event);
									}

									continue;
								}

								const finalReply =
									"Tudo bem. Esse horário não foi confirmado. Quando quiser, podemos consultar novos horários.";

								try {
									const sendResponse = await sendCompliantText({
										conversationId: conversation.id,
										leadId: lead.id,
										text: finalReply,
										to: lead.phone,
									});

									const outboundWamid = sendResponse.messages[0]?.id;

									request.log.info({
										event:
											"whatsapp_scheduling_session_closed_after_cancellation",
										sessionId: cancellationResult.session.id,
										leadId: lead.id,
										conversationId: conversation.id,
										externalId,
										outboundWamid,
									});
								} catch (err) {
									request.log.error(
										{
											err,
											event: "whatsapp_scheduling_cancellation_send_failed",
											sessionId: cancellationResult.session.id,
											leadId: lead.id,
											conversationId: conversation.id,
											externalId,
										},
										"Failed to send scheduling cancellation message to WhatsApp"
									);
								}

								if (eventReceipt.event?.id) {
									await markWhatsAppWebhookEventProcessed(eventReceipt.event);
								}

								continue;
							}

							const choiceResult = await schedulingChoiceService.resolveChoice({
								buttonId,
								conversationId: conversation.id,
								leadId: lead.id,
							});

							if (!choiceResult.ok) {
								request.log.warn({
									event: "whatsapp_scheduling_choice_rejected",
									reason: choiceResult.reason,
									buttonId,
									leadId: lead.id,
									conversationId: conversation.id,
									externalId,
								});

								if (eventReceipt.event?.id) {
									await markWhatsAppWebhookEventProcessed(eventReceipt.event);
								}

								continue;
							}

							const confirmation =
								schedulingConfirmationService.buildConfirmationMessage(
									choiceResult.slot
								);

							try {
								const sendResponse = await sendCompliantButtons({
									body: confirmation.body,
									buttons: confirmation.buttons,
									conversationId: conversation.id,
									leadId: lead.id,
									to: lead.phone,
								});

								request.log.info({
									event: "whatsapp_scheduling_confirmation_sent",
									buttonId,
									slotId: choiceResult.slot.id,
									sessionId: choiceResult.session.id,
									leadId: lead.id,
									conversationId: conversation.id,
									externalId,
									outboundWamid: sendResponse.messages[0]?.id,
								});
							} catch (err) {
								request.log.error(
									{
										err,
										event: "whatsapp_scheduling_confirmation_send_failed",
										buttonId,
										slotId: choiceResult.slot.id,
										sessionId: choiceResult.session.id,
										leadId: lead.id,
										conversationId: conversation.id,
										externalId,
									},
									"Failed to send scheduling confirmation to WhatsApp"
								);
							}

							if (eventReceipt.event?.id) {
								await markWhatsAppWebhookEventProcessed(eventReceipt.event);
							}

							continue;
						} catch (err) {
							if (eventReceipt.event?.id) {
								await markWhatsAppWebhookEventFailed(
									eventReceipt.event,
									err instanceof Error ? err.message : String(err)
								);
							}

							request.log.error(
								{
									err,
									event: "whatsapp_button_reply_processing_failed",
									externalId,
									leadId: lead.id,
									conversationId: conversation.id,
								},
								"Failed to process WhatsApp button reply"
							);
							continue;
						}
					}
					/*
					 * Fluxo textual existente.
					 *
					 * Somente mensagens de texto chegam aqui.
					 * Buttons sempre foram tratados acima.
					 */
					if (!content) {
						continue;
					}

					const targetPhone = lead.phone;

					try {
						await receiveCustomerMessage({
							content,
							conversationId: conversation.id,
							externalId,
							role: "user",
							onMarianaResponse: async (marianaResult) => {
								try {
									const sendResponse = marianaResult.schedulingOffer
										? await sendCompliantButtons({
												...(marianaResult.schedulingOffer.slots.length === 1
													? schedulingConfirmationService.buildSingleSlotConfirmationMessage(
															marianaResult.schedulingOffer.slots[0]
														)
													: buildWhatsAppSchedulingOffer(
															marianaResult.schedulingOffer.slots
														)),
												conversationId: conversation.id,
												leadId: lead.id,
												to: targetPhone,
											})
										: await sendCompliantText({
												conversationId: conversation.id,
												leadId: lead.id,
												text: marianaResult.result.reply,
												to: targetPhone,
											});

									const outboundWamid = sendResponse.messages[0]?.id;

									if (outboundWamid && marianaResult.assistantMessage?.id) {
										await db
											.update(messages)
											.set({
												externalId: outboundWamid,
											})
											.where(
												eq(messages.id, marianaResult.assistantMessage.id)
											);
									}
								} catch (err) {
									console.error(
										"[WhatsAppWebhook] Failed to send Mariana reply to WhatsApp:",
										err
									);
								} finally {
									if (eventReceipt.event) {
										await markWhatsAppWebhookEventProcessed(eventReceipt.event);
									}
								}
							},
						});
					} catch (err) {
						if (eventReceipt.event?.id) {
							await markWhatsAppWebhookEventFailed(
								eventReceipt.event,
								err instanceof Error ? err.message : String(err)
							);
						}

						request.log.error(
							{
								err,
								event: "whatsapp_text_message_processing_failed",
								externalId,
								leadId: lead.id,
								conversationId: conversation.id,
							},
							"Failed to process WhatsApp text message"
						);
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
