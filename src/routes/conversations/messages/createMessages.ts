import { eq } from "drizzle-orm";
import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import z from "zod";
import { db } from "../../../db/connections";
import { conversations, messages } from "../../../db/schema";

export const createMessages: FastifyPluginCallbackZod = (app) => {
	app.post(
		"/messages",
		{
			schema: {
				body: z.object({
					content: z.string().min(1),
					externalId: z.string().min(1).optional(),
					role: z.enum(["user", "assistant", "system"]),
				}),
				params: z.object({
					conversationId: z.uuid(),
				}),
			},
		},
		async (request, reply) => {
			const startedAt = Date.now();

			try {
				const { conversationId } = request.params;
				const { role, content, externalId } = request.body;

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
						event: "message_conversation_not_found",
					});

					return reply.code(404).send({ error: "Conversation not found" });
				}

				const [message] = await db
					.insert(messages)
					.values({
						content,
						conversationId,
						externalId,
						role,
					})
					.returning();

				const duration = Date.now() - startedAt;

				request.log.info({
					conversationId: message.conversationId,
					duration,
					event: "message_created",
					messageId: message.id,
					role: message.role,
				});

				return reply.code(201).send({
					message,
				});
			} catch (error) {
				const duration = Date.now() - startedAt;

				request.log.error({
					conversationId: request.params.conversationId,
					duration,
					error,
					event: "message_creation_failed",
				});

				return reply.code(500).send({
					error: "Failed to create message",
				});
			}
		}
	);
};
