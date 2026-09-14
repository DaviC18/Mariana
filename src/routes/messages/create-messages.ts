import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import z from "zod";
import { receiveCustomerMessage } from "../../services/conversations/receive-customer-message";

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

				const { duplicate, message } = await receiveCustomerMessage({
					content,
					conversationId,
					externalId,
					role,
				});

				const duration = Date.now() - startedAt;

				request.log.info({
					conversationId: message.conversationId,
					duration,
					event: "message_created",
					messageId: message.id,
					role: message.role,
				});

				return reply.code(201).send({
					duplicate,
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

				const statusCode =
					error instanceof Error && error.message === "Conversation not found"
						? 404
						: 500;

				return reply.code(statusCode).send({
					error: "Failed to create message",
				});
			}
		}
	);
};
