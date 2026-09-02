/** biome-ignore-all lint/style/useFilenamingConvention: <> */

import { eq } from "drizzle-orm";
import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { db } from "../../db/connections";
import { leads } from "../../db/schema";
import { conversations } from "./../../db/schema/conversations";

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
			const starteAt = Date.now();

			try {
				const { leadId } = request.body;

				const [lead] = await db
					.select({ id: leads.id })
					.from(leads)
					.where(eq(leads.id, leadId))
					.limit(1);

				if (!lead) {
					const duration = Date.now() - starteAt;

					request.log.warn({
						duration,
						event: "conversation_lead_not_found",
						leadId,
					});

					return reply.code(404).send({ error: "Lead not found" });
				}

				const [conversation] = await db
					.insert(conversations)
					.values({
						leadId,
					})
					.returning();

				const duration = Date.now() - starteAt;

				request.log.info({
					conversationId: conversations.id,
					duration,
					event: "conversation_created",
					leadId: leads.id,
				});

				return reply.code(201).send({
					conversation,
				});
			} catch (error) {
				const duration = Date.now() - starteAt;

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
