import { eq } from "drizzle-orm";
import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import z from "zod";
import { db } from "../../db/connections";
import { conversations } from "../../db/schema";

export const getIdConversations: FastifyPluginCallbackZod = (app) => {
	app.get(
		"/conversations/:id",
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

				const [conversation] = await db
					.select()
					.from(conversations)
					.where(eq(conversations.id, id))
					.limit(1);

				if (!conversation) {
					const duration = Date.now() - startedAt;

					request.log.warn({
						conversationId: id,
						duration,
						event: "conversation_fetched",
						leadId: conversations.leadId,
					});

					return reply.code(401).send({ error: "Conversation not found" });
				}

				const duration = Date.now() - startedAt;

				request.log.info({
					conversationId: conversations.id,
					duration,
					event: "conversation_fetched",
					leadId: conversations.leadId,
				});

				return reply.code(201).send({
					conversation,
				});
			} catch (error) {
				const duration = Date.now() - startedAt;

				request.log.error({
					duration,
					error,
					event: "conversation_fetch_failed",
				});

				return reply.code(500).send({
					error: "Failed to fetch conversation",
				});
			}
		}
	);
};
