/** biome-ignore-all lint/performance/noAwaitInLoops: <> */
/** biome-ignore-all lint/style/useDestructuring: <> */
/** biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: <> */
/** biome-ignore-all lint/suspicious/useAwait: <> */
/** biome-ignore-all assist/source/useSortedKeys: <> */

import { and, eq } from "drizzle-orm";
import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import z from "zod";
import { db } from "../../db/connections";
import { conversations, messages } from "../../db/schema";
import { env } from "../../env";
import { whatsAppService } from "../../integrations/whatsapp/whatsapp-service";
import type { WhatsAppWebhookPayload } from "../../integrations/whatsapp/whatsapp-types";
import { SchedulingCancellationService } from "../../services/calendar/scheduling-cancellation-service";
import { SchedulingChoiceService } from "../../services/calendar/scheduling-choice-service";
import { SchedulingConfirmationOrchestrator } from "../../services/calendar/scheduling-confirmation-orchestrator";
import { SchedulingConfirmationService } from "../../services/calendar/scheduling-confirmation-service";
import { receiveCustomerMessage } from "../../services/conversations/receive-customer-message";
import { assertWhatsAppOutboundAllowed } from "../../services/conversations/whatsapp-compliance";
import { leadIngestionService } from "../../services/leads/lead-ingestion";
import { formatSlotDate } from "../../utils/date-formatter";

const schedulingChoiceService = new SchedulingChoiceService();

const schedulingConfirmationService = new SchedulingConfirmationService();

const schedulingConfirmationOrchestrator =
	new SchedulingConfirmationOrchestrator();

const schedulingCancellationService = new SchedulingCancellationService();

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

	app.get(
		"/webhooks/whatsapp",
		{
			schema: {
				querystring: z.object({
					"hub.challenge": z.string().optional(),
					"hub.mode": z.string().optional(),
					"hub.verify_token": z.string().optional(),
				}),
			},
		},
		async (request, reply) => {
			const mode = request.query["hub.mode"];
			const token = request.query["hub.verify_token"];
			const challenge = request.query["hub.challenge"];

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
		}
	);

	app.post("/webhooks/whatsapp", async (request, reply) => {
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
						// An interactive reply is also an inbound customer action and
						// therefore renews the customer-service window.
						await db
							.update(conversations)
							.set({ lastCustomerMessageAt: new Date(), updatedAt: new Date() })
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

								continue;
							}

							/*
							 * Apenas 1 slot:
							 * a sessão já foi fechada pelo
							 * SchedulingCancellationService.
							 */
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

							continue;
						}

						/*
						 * 3. Seleção de horário
						 *
						 * buttonId é o UUID persistido
						 * do scheduling_slot.
						 */
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

						continue;
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

					await receiveCustomerMessage({
						content,
						conversationId: conversation.id,
						externalId,
						role: "user",
						onMarianaResponse: async (marianaResult) => {
							try {
								const sendResponse = await sendCompliantText({
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
										.where(eq(messages.id, marianaResult.assistantMessage.id));
								}
							} catch (err) {
								console.error(
									"[WhatsAppWebhook] Failed to send Mariana reply to WhatsApp:",
									err
								);
							}
						},
					});
				}
			}
		}

		return reply.code(200).send({
			status: "ok",
		});
	});

	done();
};
