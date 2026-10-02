/** biome-ignore-all lint/suspicious/useAwait: <> */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../../env";
import { leadIngestionService } from "../../services/leads/lead-ingestion";

const userColumnSchema = z.object({
	column_id: z.string(),
	string_value: z.string().optional(),
});

const googleAdsLeadWebhookSchema = z.object({
	adgroup_id: z.number().optional(),
	api_version: z.string().optional(),
	asset_group_id: z.number().optional(),
	campaign_id: z.number().optional(),
	creative_id: z.number().optional(),
	form_id: z.number().optional(),
	gcl_id: z.string().optional(),
	google_key: z.string().min(1),
	is_test: z.boolean().optional(),
	lead_id: z.string().min(1),
	lead_source: z.string().optional(),
	lead_stage: z.string().optional(),
	lead_submit_time: z.string().optional(),
	user_column_data: z.array(userColumnSchema).default([]),
});

type GoogleAdsLeadWebhook = z.infer<typeof googleAdsLeadWebhookSchema>;

function getUserColumnValue(
	userColumnData: GoogleAdsLeadWebhook["user_column_data"],
	columnId: string
): string | undefined {
	return userColumnData.find((column) => column.column_id === columnId)
		?.string_value;
}

export async function googleAdsWebhookRoutes(
	app: FastifyInstance
): Promise<void> {
	app.post("/webhooks/google-ads", async (request, reply) => {
		try {
			const parsed = googleAdsLeadWebhookSchema.safeParse(request.body);

			if (!parsed.success) {
				request.log.warn(
					{
						event: "google_ads_webhook_invalid_payload",
						issues: parsed.error.issues,
					},
					"Invalid Google Ads webhook payload"
				);

				return reply.code(400).send({
					error: "Invalid payload",
				});
			}

			const payload = parsed.data;

			if (payload.google_key !== env.GOOGLE_ADS_WEBHOOK_KEY) {
				request.log.warn(
					{
						event: "google_ads_webhook_invalid_key",
					},
					"Invalid Google Ads webhook key"
				);

				return reply.code(401).send({
					error: "Unauthorized",
				});
			}

			const name = getUserColumnValue(payload.user_column_data, "FULL_NAME");

			const email = getUserColumnValue(payload.user_column_data, "EMAIL");

			const phone = getUserColumnValue(
				payload.user_column_data,
				"PHONE_NUMBER"
			);

			if (!phone) {
				request.log.warn(
					{
						event: "google_ads_webhook_missing_phone",
						leadId: payload.lead_id,
					},
					"Google Ads lead does not contain a phone number"
				);

				return reply.code(400).send({
					error: "PHONE_NUMBER is required",
				});
			}

			if (payload.is_test) {
				request.log.info(
					{
						event: "google_ads_webhook_test_lead",
						formId: payload.form_id,
						leadId: payload.lead_id,
					},
					"Google Ads test lead received"
				);

				return reply.code(200).send({
					status: "ok",
					test: true,
				});
			}

			const result = await leadIngestionService.ingest({
				adGroupId:
					payload.adgroup_id === undefined
						? undefined
						: String(payload.adgroup_id),
				adId:
					payload.creative_id === undefined
						? undefined
						: String(payload.creative_id),
				campaignId:
					payload.campaign_id === undefined
						? undefined
						: String(payload.campaign_id),
				email,
				gclid: payload.gcl_id,
				name,
				phone,
				source: "google_ads",
				sourceLeadId: payload.lead_id,
			});

			request.log.info(
				{
					event: result.created
						? "google_ads_lead_created"
						: "google_ads_lead_reused",
					leadId: result.lead.id,
					sourceLeadId: payload.lead_id,
				},
				"Google Ads lead processed"
			);

			return reply.code(200).send({
				created: result.created,
				leadId: result.lead.id,
				status: "ok",
			});
		} catch (error) {
			request.log.error(
				{
					err: error,
					event: "google_ads_webhook_processing_error",
				},
				"Unexpected error while processing Google Ads webhook"
			);

			return reply.code(500).send({
				error: "Internal server error",
			});
		}
	});
}
