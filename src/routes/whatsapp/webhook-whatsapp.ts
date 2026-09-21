/** biome-ignore-all lint/performance/noAwaitInLoops: <> */
/** biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: <> */
/** biome-ignore-all lint/suspicious/useAwait: <> */
/** biome-ignore-all assist/source/useSortedKeys: <> */

import { and, eq } from "drizzle-orm";
import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import z from "zod";
import { db } from "../../db/connections";
import { conversations, leads, messages } from "../../db/schema";
import { env } from "../../env";
import { whatsAppService } from "../../integrations/whatsapp/whatsapp-service";
import type { WhatsAppWebhookPayload } from "../../integrations/whatsapp/whatsapp-types";
import { receiveCustomerMessage } from "../../services/conversations/receive-customer-message";

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
				request.log.info({ event: "whatsapp_webhook_verified" });
				return reply
					.code(200)
					.type("text/plain")
					.send(challenge ?? "");
			}

			request.log.warn({
				event: "whatsapp_webhook_verification_failed",
				token,
			});
			return reply.code(403).send({ error: "Forbidden" });
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
			request.log.warn({ event: "whatsapp_webhook_invalid_signature" });
			return reply.code(401).send({ error: "Invalid signature" });
		}

		const payload = request.body as WhatsAppWebhookPayload;

		if (payload.object !== "whatsapp_business_account" || !payload.entry) {
			return reply.code(200).send({ status: "ignored" });
		}

		for (const entry of payload.entry) {
			if (!entry.changes) {
				continue;
			}
			for (const change of entry.changes) {
				const { value } = change;
				if (value?.statuses) {
					for (const status of value.statuses) {
						request.log.info({
							event: "whatsapp_message_status",
							messageId: status.id,
							status: status.status,
							timestamp: status.timestamp,
							recipientId: status.recipient_id,
							...(status.errors ? { errors: status.errors } : {}),
						});
					}
				}

				if (!value?.messages || value.messages.length === 0) {
					continue;
				}

				for (const message of value.messages) {
					if (message.type !== "text" || !message.text?.body) {
						continue;
					}

					const phone = message.from;
					const content = message.text.body;
					const externalId = message.id;

					const contact = value.contacts?.find((c) => c.wa_id === phone);
					const profileName = contact?.profile?.name;

					let [lead] = await db
						.select()
						.from(leads)
						.where(eq(leads.phone, phone))
						.limit(1);

					if (!lead) {
						[lead] = await db
							.insert(leads)
							.values({
								name: profileName || phone,
								phone,
								consortiumType: "geral",
								objective: "geral",
							})
							.returning();
					}

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

					const targetPhone = lead.phone;
					await receiveCustomerMessage({
						content,
						conversationId: conversation.id,
						externalId,
						role: "user",
						onMarianaResponse: async (marianaResult) => {
							try {
								const sendResponse = await whatsAppService.sendTextMessage(
									targetPhone,
									marianaResult.result.reply
								);
								const outboundWamid = sendResponse.messages[0]?.id;
								if (outboundWamid && marianaResult.assistantMessage?.id) {
									await db
										.update(messages)
										.set({ externalId: outboundWamid })
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

		return reply.code(200).send({ status: "ok" });
	});

	done();
};
