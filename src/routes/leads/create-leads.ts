/** biome-ignore-all lint/style/useFilenamingConvention: <> */
/** biome-ignore-all lint/complexity/noUselessCatchBinding: <> */
/** biome-ignore-all lint/correctness/noUnusedVariables: <> */
import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import z from "zod";
import { db } from "../../db/connections";
import { leads } from "../../db/schema";

export const createLeads: FastifyPluginCallbackZod = (app) => {
	app.post(
		"/leads",
		{
			schema: {
				body: z.object({
					consortiumType: z.string().min(1),
					name: z.string().min(1),
					objective: z.string().min(1),
					phone: z.string().min(1),
				}),
			},
		},
		async (request, reply) => {
			const starteAt = Date.now();
			const leadData = request.body;

			request.log.info({
				event: "lead_creation_start",
			});

			try {
				const [lead] = await db
					.insert(leads)
					.values({
						consortiumType: leadData.consortiumType,
						name: leadData.name,
						objective: leadData.objective,
						phone: leadData.phone,
					})
					.returning();

				const duration = Date.now() - starteAt;

				request.log.info({
					duration,
					event: "lead_created",
					leadID: lead.id,
				});
				return reply.code(201).send({ lead });
			} catch (error) {
				request.log.error({ error, event: "lead_creation_failed" });
				reply.code(500).send({ error: "Failed to create lead" });
			}
		}
	);
};
