import assert from "node:assert/strict";
import test from "node:test";

import fastify from "fastify";
import {
	serializerCompiler,
	validatorCompiler,
	type ZodTypeProvider,
} from "fastify-type-provider-zod";

import { createAppointments } from "../../routes/appointments/create-appointments";

function buildApp() {
	const app = fastify().withTypeProvider<ZodTypeProvider>();
	app.setValidatorCompiler(validatorCompiler);
	app.setSerializerCompiler(serializerCompiler);
	app.register(createAppointments);
	return app;
}

test("a rota rejeita payload inválido antes de chamar o agendamento", async (t) => {
	const app = buildApp();
	t.after(() => app.close());

	const response = await app.inject({
		method: "POST",
		payload: {
			consultantId: "não-é-uuid",
			endAt: "2026-10-01T10:30:00-03:00",
			externalEventId: "não deve ser aceito",
			leadId: "também-não-é-uuid",
			startAt: "2026-10-01T10:00:00-03:00",
		},
		url: "/appointments",
	});

	assert.equal(response.statusCode, 400);
});
