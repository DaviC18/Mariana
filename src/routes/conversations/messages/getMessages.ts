import { asc } from "drizzle-orm";
import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import { db } from "../../../db/connections";
import { messages } from "../../../db/schema";

export const getMessages: FastifyPluginCallbackZod = (app) => {
	app.get("/messages", async (request, reply) => {
		const startedAt = Date.now();

		try {
			const result = await db
				.select()
				.from(messages)
				.orderBy(asc(messages.createdAt));

			const duration = Date.now() - startedAt;

			request.log.info({
				count: result.length,
				duration,
				event: "messages_fetched",
			});

			return reply.code(201).send({ messages: result });
		} catch (error) {
			const duration = Date.now() - startedAt;

			request.log.error({
				duration,
				error,
				event: "messages_fetch_failed",
			});

			return reply.code(500).send({ error: "Failed to fetch messages" });
		}
	});
};
