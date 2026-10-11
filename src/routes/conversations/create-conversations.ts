/** biome-ignore-all lint/style/useFilenamingConvention: <> */

import { and, eq } from "drizzle-orm";
import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import { z } from "zod";

import { db } from "../../db/connections";
import { conversations, leads } from "../../db/schema";

export const createConversations: FastifyPluginCallbackZod = (app) => {
	app.post(
		"/conversations",
		{
			schema: {
				body: z.object({
					leadId: z.uuid(),
				}),
			},
		},
		async (request, reply) => {
			const startedAt = Date.now();

			try {
				const { leadId } = request.body;

				const [lead] = await db
					.select({ id: leads.id })
					.from(leads)
					.where(eq(leads.id, leadId))
					.limit(1);

				if (!lead) {
					const duration = Date.now() - startedAt;

					request.log.warn({
						duration,
						event: "conversation_lead_not_found",
						leadId,
					});

					return reply.code(404).send({
						error: "Lead not found",
					});
				}

				const [activeConversation] = await db
					.select()
					.from(conversations)
					.where(
						and(
							eq(conversations.leadId, leadId),
							eq(conversations.status, "active")
						)
					)
					.limit(1);

				if (activeConversation) {
					const duration = Date.now() - startedAt;

					request.log.info({
						conversationId: activeConversation.id,
						duration,
						event: "conversation_already_active",
						leadId: activeConversation.leadId,
					});

					return reply.code(200).send({
						conversation: activeConversation,
					});
				}

				const [conversation] = await db
					.insert(conversations)
					.values({
						leadId,
					})
					.returning();

				const duration = Date.now() - startedAt;

				request.log.info({
					conversationId: conversation.id,
					duration,
					event: "conversation_created",
					leadId: conversation.leadId,
				});

				return reply.code(201).send({
					conversation,
				});
			} catch (error) {
				const duration = Date.now() - startedAt;

				request.log.error({
					duration,
					error,
					event: "conversation_creation_failed",
				});

				return reply.code(500).send({
					error: "Failed to create conversation",
				});
			}
		}
	);
};
