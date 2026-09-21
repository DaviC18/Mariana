import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import { db } from "../../db/connections";
import { consultants } from "../../db/schema/consultants";
import { GoogleCalendarService } from "../../integrations/google-calendar/google-calendar-service";

test("cria evento no Google Calendar", async () => {
	const [joao] = await db
		.select({
			calendarId: consultants.calendarId,
			id: consultants.id,
			name: consultants.name,
		})
		.from(consultants)
		.where(eq(consultants.name, "João Silva"))
		.limit(1);

	assert.ok(joao);

	const service = new GoogleCalendarService();

	const start = new Date("2026-09-21T18:30:00-03:00");
	const end = new Date("2026-09-21T19:00:00-03:00");

	let eventId: string | undefined;

	try {
		const event = await service.createEvent({
			calendarId: joao.calendarId,
			description: "Evento criado automaticamente pela Mariana.",
			end,
			start,
			summary: "Teste Mariana - Agendamento",
		});

		eventId = event.id;
		assert.ok(event.id);
		assert.equal(event.summary, "Teste Mariana - Agendamento");
	} finally {
		if (eventId) {
			await service.deleteEvent(joao.calendarId, eventId);
		}
	}
});
