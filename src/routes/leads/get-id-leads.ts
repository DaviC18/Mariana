import { eq } from "drizzle-orm";
import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import z from "zod";
import { db } from "../../db/connections";
import { leads } from "../../db/schema";

export const getIdLeads: FastifyPluginCallbackZod = (app) => {
	app.get(
		"/leads/:id",
		{
			schema: {
				params: z.object({
					id: z.uuid(),
				}),
			},
		},
		async (request, reply) => {
			const starteAt = Date.now();

			try {
				const { id } = request.params;

				const [lead] = await db
					.select()
					.from(leads)
					.where(eq(leads.id, id))
					.limit(1);

				const duration = Date.now() - starteAt;

				if (!lead) {
					request.log.warn({
						duration,
						event: "lead_nou_found",
						leadId: id,
					});
					return reply.code(401).send({ error: "Lead not found" });
				}

				request.log.info({
					duration,
					event: "lead_fetched",
					leadId: lead.id,
				});

				return reply.code(200).send({
					lead,
				});
			} catch (error) {
				const duration = Date.now() - starteAt;

				request.log.error({
					duration,
					error,
					event: "lead_fetch_failed",
				});

				return reply.code(500).send({ error: "Failed to fetch lead" });
			}
		}
	);
};
