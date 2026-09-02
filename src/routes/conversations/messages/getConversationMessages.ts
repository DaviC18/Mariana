/** biome-ignore-all lint/style/useFilenamingConvention: <> */

import { asc, eq } from "drizzle-orm";
import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import { z } from "zod";

import { db } from "../../../db/connections";
import { conversations, messages } from "../../../db/schema";

export const getConversationMessages: FastifyPluginCallbackZod = (app) => {
	app.get(
		"/conversations/:conversationId/messages",
		{
			schema: {
				params: z.object({
					conversationId: z.uuid(),
				}),
			},
		},
		async (request, reply) => {
			const startedAt = Date.now();

			try {
				const { conversationId } = request.params;

				const [conversation] = await db
					.select({ id: conversations.id })
					.from(conversations)
					.where(eq(conversations.id, conversationId))
					.limit(1);

				if (!conversation) {
					const duration = Date.now() - startedAt;

					request.log.warn({
						conversationId,
						duration,
						event: "conversation_not_found",
					});

					return reply.code(404).send({
						error: "Conversation not found",
					});
				}

				const result = await db
					.select()
					.from(messages)
					.where(eq(messages.conversationId, conversationId))
					.orderBy(asc(messages.createdAt));

				const duration = Date.now() - startedAt;

				request.log.info({
					conversationId,
					count: result.length,
					duration,
					event: "conversation_messages_fetched",
				});

				return reply.code(200).send({
					conversationId,
					messages: result,
				});
			} catch (error) {
				const duration = Date.now() - startedAt;

				request.log.error({
					conversationId: request.params.conversationId,
					duration,
					error,
					event: "conversation_messages_fetch_failed",
				});

				return reply.code(500).send({
					error: "Failed to fetch conversation messages",
				});
			}
		}
	);
};
