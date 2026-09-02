import { eq } from "drizzle-orm";
import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import z from "zod";
import { db } from "../../../db/connections";
import { messages } from "../../../db/schema";

export const getIdMessages: FastifyPluginCallbackZod = (app) => {
	app.get(
		"/messages/:id",
		{
			schema: {
				params: z.object({
					id: z.uuid(),
				}),
			},
		},
		async (request, reply) => {
			const startedAt = Date.now();

			try {
				const { id } = request.params;

				const [message] = await db
					.select()
					.from(messages)
					.where(eq(messages.id, id))
					.limit(1);

				if (!message) {
					const duration = Date.now() - startedAt;

					request.log.warn({
						duration,
						event: "message_not_found",
						messageId: id,
					});

					reply.code(404).send({ error: "Message not found" });
				}

				const duration = Date.now() - startedAt;

				request.log.info({
					conversationId: message.conversationId,
					duration,
					event: "message_fetched",
					messageId: message.id,
				});

				return reply.code(201).send({
					message,
				});
			} catch (error) {
				const duration = Date.now() - startedAt;

				request.log.error({
					duration,
					error,
					event: "message_fetch_failed",
					messageId: request.params.id,
				});

				return reply.code(500).send({ error: "Failed to fetch message" });
			}
		}
	);
};
