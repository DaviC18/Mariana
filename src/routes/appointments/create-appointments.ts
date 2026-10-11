/** biome-ignore-all lint/style/useFilenamingConvention: <> */

import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import { z } from "zod";

import {
	AppointmentService,
	AppointmentServiceError,
} from "../../services/calendar/appointment-service";

const appointmentService = new AppointmentService();

function getStatusCode(error: unknown): number {
	if (!(error instanceof AppointmentServiceError)) {
		return 500;
	}

	if (
		error.code === "consultant_not_found" ||
		error.code === "lead_not_found"
	) {
		return 404;
	}

	if (error.code === "slot_unavailable") {
		return 409;
	}

	return 400;
}

export const createAppointments: FastifyPluginCallbackZod = (app) => {
	app.post(
		"/appointments",
		{
			schema: {
				body: z.object({
					consultantId: z.uuid(),
					endAt: z.coerce.date(),
					leadId: z.uuid(),
					startAt: z.coerce.date(),
				}),
			},
		},
		async (request, reply) => {
			const startedAt = Date.now();

			try {
				const appointment = await appointmentService.createConfirmedAppointment(
					request.body
				);

				request.log.info({
					appointmentId: appointment.appointmentId,
					consultantId: appointment.consultantId,
					duration: Date.now() - startedAt,
					event: "appointment_created",
					leadId: request.body.leadId,
				});

				return reply.code(201).send({ appointment });
			} catch (error) {
				const statusCode = getStatusCode(error);

				request.log[statusCode >= 500 ? "error" : "warn"]({
					duration: Date.now() - startedAt,
					error,
					event: "appointment_creation_failed",
					leadId: request.body.leadId,
				});

				return reply.code(statusCode).send({
					error:
						error instanceof Error
							? error.message
							: "Failed to create appointment",
				});
			}
		}
	);
};
