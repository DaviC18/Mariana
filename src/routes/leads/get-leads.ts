import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";

import { db } from "../../db/connections";
import { leads } from "../../db/schema";

export const getLeads: FastifyPluginCallbackZod = (app) => {
	app.get("/leads", async (request, reply) => {
		const startedAt = Date.now();

		try {
			const result = await db.select().from(leads);

			const duration = Date.now() - startedAt;

			request.log.info({
				count: result.length,
				duration,
				event: "leads_fetched",
			});

			return reply.code(200).send({
				leads: result,
			});
		} catch (error) {
			const duration = Date.now() - startedAt;

			request.log.error({
				duration,
				error,
				event: "leads_fetch_failed",
			});

			return reply.code(500).send({
				error: "Failed to fetch leads",
			});
		}
	});
};
