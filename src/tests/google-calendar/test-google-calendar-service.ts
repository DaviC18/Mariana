import { db } from "../../db/connections";
import { consultants } from "../../db/schema/consultants";
import { GoogleCalendarService } from "../../integrations/google-calendar/google-calendar-service";

async function main() {
	const consultantRows = await db
		.select({
			calendarId: consultants.calendarId,
			name: consultants.name,
		})
		.from(consultants);

	const calendarIds = consultantRows.map((consultant) => consultant.calendarId);

	const timeMin = new Date();
	const timeMax = new Date(timeMin.getTime() + 24 * 60 * 60 * 1000);

	const service = new GoogleCalendarService();

	const availability = await service.getBusyPeriods(
		calendarIds,
		timeMin,
		timeMax
	);

	console.log("\nDisponibilidade:\n");

	for (const consultant of consultantRows) {
		const calendar = availability.find(
			(item) => item.calendarId === consultant.calendarId
		);

		console.log(`--- ${consultant.name} ---`);

		if (!calendar?.busy.length) {
			console.log("Status: LIVRE");
			continue;
		}

		console.log("Períodos ocupados:");

		for (const period of calendar.busy) {
			console.log(`  ${period.start} → ${period.end}`);
		}
	}
}

main().catch((error) => {
	console.error("Erro no GoogleCalendarService:");

	if (error instanceof Error) {
		console.error(error.message);
	} else {
		console.error(error);
	}

	process.exit(1);
});
