/** biome-ignore-all lint/style/useFilenamingConvention: <> */

import { eq } from "drizzle-orm";
import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import { z } from "zod";

import { db } from "../../db/connections";
import { appointments } from "../../db/schema";

export const getIdAppointments: FastifyPluginCallbackZod = (app) => {
	app.get(
		"/appointments/:id",
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

				const [appointment] = await db
					.select()
					.from(appointments)
					.where(eq(appointments.id, id))
					.limit(1);

				if (!appointment) {
					const duration = Date.now() - startedAt;

					request.log.warn({
						appointmentId: id,
						duration,
						event: "appointment_not_found",
					});

					return reply.code(404).send({
						error: "Appointment not found",
					});
				}

				const duration = Date.now() - startedAt;

				request.log.info({
					appointmentId: appointment.id,
					consultantId: appointment.consultantId,
					duration,
					event: "appointment_fetched",
					leadId: appointment.leadId,
				});

				return reply.code(200).send({
					appointment,
				});
			} catch (error) {
				const duration = Date.now() - startedAt;

				request.log.error({
					appointmentId: request.params.id,
					duration,
					error,
					event: "appointment_fetch_failed",
				});

				return reply.code(500).send({
					error: "Failed to fetch appointment",
				});
			}
		}
	);
};
