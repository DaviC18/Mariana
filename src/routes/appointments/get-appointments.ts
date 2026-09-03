/** biome-ignore-all lint/style/useFilenamingConvention: <> */

import { asc } from "drizzle-orm";
import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";

import { db } from "../../db/connections";
import { appointments } from "../../db/schema";

export const getAppointments: FastifyPluginCallbackZod = (app) => {
	app.get("/appointments", async (request, reply) => {
		const startedAt = Date.now();

		try {
			const result = await db
				.select()
				.from(appointments)
				.orderBy(asc(appointments.startAt));

			const duration = Date.now() - startedAt;

			request.log.info({
				count: result.length,
				duration,
				event: "appointments_fetched",
			});

			return reply.code(200).send({
				appointments: result,
			});
		} catch (error) {
			const duration = Date.now() - startedAt;

			request.log.error({
				duration,
				error,
				event: "appointments_fetch_failed",
			});

			return reply.code(500).send({
				error: "Failed to fetch appointments",
			});
		}
	});
};
