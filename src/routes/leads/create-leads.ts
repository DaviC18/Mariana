/** biome-ignore-all lint/style/useFilenamingConvention: <> */
/** biome-ignore-all lint/complexity/noUselessCatchBinding: <> */
/** biome-ignore-all lint/correctness/noUnusedVariables: <> */
import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import z from "zod";
import { db } from "../../db/connections";
import { leads } from "../../db/schema";
import { isAtLeast18 } from "../../services/leads/lead-qualification";

export const createLeads: FastifyPluginCallbackZod = (app) => {
	app.post(
		"/leads",
		{
			schema: {
				body: z.object({
					birthDate: z.coerce.date().optional(),
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

			if (leadData.birthDate && !isAtLeast18(leadData.birthDate)) {
				return reply.code(400).send({
					error: "Lead must be at least 18 years old",
				});
			}

			request.log.info({
				event: "lead_creation_start",
			});

			try {
				const [lead] = await db
					.insert(leads)
					.values({
						consortiumType: leadData.consortiumType,
						...(leadData.birthDate === undefined
							? {}
							: { birthDate: leadData.birthDate }),
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
