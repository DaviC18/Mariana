/** biome-ignore-all lint/style/useFilenamingConvention: <> */

import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import { z } from "zod";

import {
	SchedulingAvailabilityError,
	SchedulingAvailabilityService,
} from "../../services/calendar/scheduling-availability";

const schedulingAvailabilityService = new SchedulingAvailabilityService();

export const getAppointmentAvailability: FastifyPluginCallbackZod = (app) => {
	app.get(
		"/appointments/availability",
		{
			schema: {
				querystring: z.object({
					leadId: z.uuid(),
					timeMax: z.coerce.date(),
					timeMin: z.coerce.date(),
				}),
			},
		},
		async (request, reply) => {
			try {
				const slots = await schedulingAvailabilityService.getAvailableSlots(
					request.query
				);

				return reply.send({ slots });
			} catch (error) {
				let statusCode = 500;
				if (error instanceof SchedulingAvailabilityError) {
					statusCode = error.code === "lead_not_found" ? 404 : 400;
				}

				return reply.code(statusCode).send({
					error:
						error instanceof Error
							? error.message
							: "Failed to fetch appointment availability",
				});
			}
		}
	);
};
