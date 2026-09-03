/** biome-ignore-all lint/style/useFilenamingConvention: <> */

import { eq } from "drizzle-orm";
import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import { z } from "zod";

import { db } from "../../db/connections";
import { appointments, consultants, leads } from "../../db/schema";

export const createAppointments: FastifyPluginCallbackZod = (app) => {
	app.post(
		"/appointments",
		{
			schema: {
				body: z.object({
					consultantId: z.uuid(),
					endAt: z.coerce.date(),
					externalEventId: z.string().min(1),
					leadId: z.uuid(),
					startAt: z.coerce.date(),
				}),
			},
		},
		async (request, reply) => {
			const startedAt = Date.now();

			try {
				const { leadId, consultantId, externalEventId, startAt, endAt } =
					request.body;

				if (endAt <= startAt) {
					const duration = Date.now() - startedAt;

					request.log.warn({
						duration,
						event: "appointment_invalid_time_range",
					});

					return reply.code(400).send({
						error: "endAt must be greater than startAt",
					});
				}

				const [lead] = await db
					.select({ id: leads.id })
					.from(leads)
					.where(eq(leads.id, leadId))
					.limit(1);

				if (!lead) {
					const duration = Date.now() - startedAt;

					request.log.warn({
						duration,
						event: "appointment_lead_not_found",
						leadId,
					});

					return reply.code(404).send({
						error: "Lead not found",
					});
				}

				const [consultant] = await db
					.select({
						active: consultants.active,
						id: consultants.id,
					})
					.from(consultants)
					.where(eq(consultants.id, consultantId))
					.limit(1);

				if (!consultant) {
					const duration = Date.now() - startedAt;

					request.log.warn({
						consultantId,
						duration,
						event: "appointment_consultant_not_found",
					});

					return reply.code(404).send({
						error: "Consultant not found",
					});
				}

				if (!consultant.active) {
					const duration = Date.now() - startedAt;

					request.log.warn({
						consultantId,
						duration,
						event: "appointment_consultant_inactive",
					});

					return reply.code(400).send({
						error: "Consultant is inactive",
					});
				}

				const [appointment] = await db
					.insert(appointments)
					.values({
						consultantId,
						endAt,
						externalEventId,
						leadId,
						startAt,
					})
					.returning();

				const duration = Date.now() - startedAt;

				request.log.info({
					appointmentId: appointment.id,
					consultantId: appointment.consultantId,
					duration,
					event: "appointment_created",
					leadId: appointment.leadId,
				});

				return reply.code(201).send({
					appointment,
				});
			} catch (error) {
				const duration = Date.now() - startedAt;

				request.log.error({
					duration,
					error,
					event: "appointment_creation_failed",
				});

				return reply.code(500).send({
					error: "Failed to create appointment",
				});
			}
		}
	);
};
