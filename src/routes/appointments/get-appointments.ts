/** biome-ignore-all lint/style/useFilenamingConvention: <> */

import { and, asc, eq, gte, lte } from "drizzle-orm";
import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import { z } from "zod";

import { db } from "../../db/connections";
import { appointments } from "../../db/schema";
import { APPOINTMENT_STATUSES } from "../../services/appointments/appointment-status";

export const getAppointments: FastifyPluginCallbackZod = (app) => {
	app.get(
		"/appointments",
		{
			schema: {
				querystring: z.object({
					consultantId: z.uuid().optional(),
					endAt: z.coerce.date().optional(),
					leadId: z.uuid().optional(),
					startAt: z.coerce.date().optional(),
					status: z.enum(APPOINTMENT_STATUSES).optional(),
				}),
			},
		},
		async (request, reply) => {
			const startedAt = Date.now();

			try {
				const { consultantId, endAt, leadId, startAt, status } = request.query;

				if (startAt && endAt && startAt > endAt) {
					return reply.code(400).send({
						error: "startAt must be earlier than or equal to endAt",
					});
				}

				const conditions = [
					consultantId
						? eq(appointments.consultantId, consultantId)
						: undefined,
					leadId ? eq(appointments.leadId, leadId) : undefined,
					status ? eq(appointments.status, status) : undefined,
					startAt ? gte(appointments.startAt, startAt) : undefined,
					endAt ? lte(appointments.endAt, endAt) : undefined,
				].filter((condition) => condition !== undefined);

				const result = await db
					.select()
					.from(appointments)
					.where(and(...conditions))
					.orderBy(asc(appointments.startAt));

				request.log.info({
					count: result.length,
					duration: Date.now() - startedAt,
					event: "appointments_fetched",
				});

				return reply.send({ appointments: result });
			} catch (error) {
				request.log.error({
					duration: Date.now() - startedAt,
					error,
					event: "appointments_fetch_failed",
				});

				return reply.code(500).send({
					error: "Failed to fetch appointments",
				});
			}
		}
	);
};
