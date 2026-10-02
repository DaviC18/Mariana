/** biome-ignore-all lint/suspicious/useAwait: <> */
/** biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: <> */

import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import { z } from "zod";

import { env } from "../../env";
import { verifyWebhookSignature } from "../../utils/verify-webhook-signature";

const metaWebhookVerificationSchema = z.object({
	"hub.challenge": z.string().min(1),
	"hub.mode": z.literal("subscribe"),
	"hub.verify_token": z.string().min(1),
});

const metaLeadgenValueSchema = z.object({
	ad_id: z.coerce.string().optional(),
	adgroup_id: z.coerce.string().optional(),
	created_time: z.coerce.number().optional(),
	form_id: z.coerce.string().optional(),
	leadgen_id: z.coerce.string().min(1),
	page_id: z.coerce.string().optional(),
});

const metaChangeSchema = z.object({
	field: z.string(),
	value: z.unknown().optional(),
});

const metaWebhookPayloadSchema = z.object({
	entry: z.array(
		z.object({
			changes: z.array(metaChangeSchema).optional(),
			id: z.string().optional(),
			time: z.coerce.number().optional(),
		})
	),
	object: z.string(),
});

export const metaAdsWebhookRoutes: FastifyPluginCallbackZod = (
	app,
	_opts,
	done
) => {
	app.addContentTypeParser(
		"application/json",
		{ parseAs: "string" },
		(request, body, doneParsing) => {
			try {
				(request as unknown as { rawBody: string }).rawBody = body as string;

				const json = JSON.parse(body as string);

				doneParsing(null, json);
			} catch (error) {
				doneParsing(error as Error, undefined);
			}
		}
	);

	app.get(
		"/webhooks/meta-ads",
		{
			schema: {
				querystring: metaWebhookVerificationSchema,
			},
		},
		async (request, reply) => {
			try {
				const { "hub.challenge": challenge, "hub.verify_token": verifyToken } =
					request.query;

				if (verifyToken !== env.META_ADS_VERIFY_TOKEN) {
					request.log.warn(
						{
							event: "meta_ads_webhook_invalid_verify_token",
						},
						"Invalid Meta Ads webhook verify token"
					);

					return reply.code(403).send({
						error: "Forbidden",
					});
				}

				request.log.info(
					{
						event: "meta_ads_webhook_verified",
					},
					"Meta Ads webhook verification successful"
				);

				return reply.code(200).type("text/plain").send(challenge);
			} catch (error) {
				request.log.error(
					{
						err: error,
						event: "meta_ads_webhook_verification_error",
					},
					"Unexpected error during Meta Ads webhook verification"
				);

				return reply.code(500).send({
					error: "Internal server error",
				});
			}
		}
	);

	app.post("/webhooks/meta-ads", async (request, reply) => {
		try {
			const signatureHeader = request.headers["x-hub-signature-256"] as
				| string
				| undefined;

			const rawBody =
				(request as unknown as { rawBody?: string }).rawBody ??
				JSON.stringify(request.body);

			const isValidSignature = verifyWebhookSignature({
				rawBody,
				secret: env.META_ADS_APP_SECRET,
				signatureHeader,
			});

			if (!isValidSignature) {
				request.log.warn(
					{
						event: "meta_ads_webhook_invalid_signature",
					},
					"Invalid Meta Ads webhook signature"
				);

				return reply.code(401).send({
					error: "Invalid signature",
				});
			}

			const parsed = metaWebhookPayloadSchema.safeParse(request.body);

			if (!parsed.success) {
				request.log.warn(
					{
						event: "meta_ads_webhook_invalid_payload",
						issues: parsed.error.issues,
					},
					"Invalid Meta Ads webhook payload"
				);

				return reply.code(400).send({
					error: "Invalid payload",
				});
			}

			const payload = parsed.data;

			if (payload.object !== "page") {
				request.log.info(
					{
						event: "meta_ads_webhook_ignored_object",
						object: payload.object,
					},
					"Ignoring unsupported Meta webhook object"
				);

				return reply.code(200).send({
					status: "ignored",
				});
			}

			let leadgenEvents = 0;

			for (const entry of payload.entry) {
				for (const change of entry.changes ?? []) {
					if (change.field !== "leadgen") {
						continue;
					}

					const parsedValue = metaLeadgenValueSchema.safeParse(change.value);

					if (!parsedValue.success) {
						request.log.warn(
							{
								event: "meta_ads_webhook_invalid_payload",
								issues: parsedValue.error.issues,
							},
							"Invalid Meta Ads leadgen value payload"
						);

						return reply.code(400).send({
							error: "Invalid payload",
						});
					}

					leadgenEvents += 1;

					request.log.info(
						{
							adGroupId: parsedValue.data.adgroup_id,
							adId: parsedValue.data.ad_id,
							createdTime: parsedValue.data.created_time,
							event: "meta_ads_leadgen_received",
							formId: parsedValue.data.form_id,
							leadgenId: parsedValue.data.leadgen_id,
							pageId: parsedValue.data.page_id,
						},
						"Meta Ads leadgen notification received"
					);
				}
			}

			if (leadgenEvents === 0) {
				request.log.info(
					{
						event: "meta_ads_webhook_no_leadgen_event",
					},
					"Meta Ads webhook contained no leadgen event"
				);

				return reply.code(200).send({
					status: "ignored",
				});
			}

			return reply.code(200).send({
				leadgenEvents,
				status: "ok",
			});
		} catch (error) {
			request.log.error(
				{
					err: error,
					event: "meta_ads_webhook_processing_error",
				},
				"Unexpected error while processing Meta Ads webhook"
			);

			return reply.code(500).send({
				error: "Internal server error",
			});
		}
	});

	done();
};
