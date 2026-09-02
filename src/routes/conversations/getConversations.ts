import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import { db } from "../../db/connections";
import { conversations } from "../../db/schema";

export const getConversatios: FastifyPluginCallbackZod = (app) => {
	app.get("/conversations", async (request, reply) => {
		const startedAt = Date.now();

		try {
			const result = await db.select().from(conversations);

			const duration = Date.now() - startedAt;

			request.log.info({
				count: result.length,
				duration,
				event: "conversations_fetched",
			});

			return reply.code(200).send({
				conversations: result,
			});
		} catch (error) {
			const duration = Date.now() - startedAt;

			request.log.error({
				duration,
				error,
				event: "converstions_fetch_failed",
			});

			return reply.code(500).send({
				error: "Failed to fetch conversations",
			});
		}
	});
};
