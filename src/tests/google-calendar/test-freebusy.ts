import { eq } from "drizzle-orm";
import { google } from "googleapis";

import { db } from "../../db/connections";
import { consultants } from "../../db/schema/consultants";
import { googleCalendarConnections } from "../../db/schema/google-calendar-connections";
import { env } from "../../env";

async function main() {
	const [connection] = await db
		.select({
			googleAccountEmail: googleCalendarConnections.googleAccountEmail,
			refreshToken: googleCalendarConnections.refreshToken,
		})
		.from(googleCalendarConnections)
		.limit(1);

	if (!connection) {
		throw new Error("Nenhuma conexão Google Calendar encontrada.");
	}

	console.log("Conta Google:", connection.googleAccountEmail);
	console.log("Refresh token encontrado: true");

	const consultantRows = await db
		.select({
			calendarId: consultants.calendarId,
			name: consultants.name,
		})
		.from(consultants)
		.where(eq(consultants.active, true));

	if (consultantRows.length === 0) {
		throw new Error("Nenhum consultor ativo encontrado.");
	}

	const oauth2Client = new google.auth.OAuth2(
		env.GOOGLE_CLIENT_ID,
		env.GOOGLE_CLIENT_SECRET,
		env.GOOGLE_REDIRECT_URI
	);

	oauth2Client.setCredentials({
		refresh_token: connection.refreshToken,
	});

	const calendar = google.calendar({
		auth: oauth2Client,
		version: "v3",
	});

	const timeMin = new Date();
	const timeMax = new Date(timeMin.getTime() + 24 * 60 * 60 * 1000);

	console.log("\nConsultando disponibilidade:");
	console.log("Início:", timeMin.toISOString());
	console.log("Fim:", timeMax.toISOString());

	const response = await calendar.freebusy.query({
		requestBody: {
			items: consultantRows.map((consultant) => ({
				id: consultant.calendarId,
			})),
			timeMax: timeMax.toISOString(),
			timeMin: timeMin.toISOString(),
			timeZone: "America/Sao_Paulo",
		},
	});

	console.log("\nResultado:\n");

	for (const consultant of consultantRows) {
		const calendarData = response.data.calendars?.[consultant.calendarId];

		console.log(`--- ${consultant.name} ---`);
		console.log("Calendar ID:", consultant.calendarId);

		if (calendarData?.errors?.length) {
			console.log("Erros:", calendarData.errors);
			continue;
		}

		if (!calendarData?.busy?.length) {
			console.log("Status: LIVRE durante todo o período");
			continue;
		}

		console.log("Períodos ocupados:");

		for (const busyPeriod of calendarData.busy) {
			console.log(`  ${busyPeriod.start} → ${busyPeriod.end}`);
		}
	}
}

main().catch((error) => {
	console.error("\nErro no teste FreeBusy:");

	if (error instanceof Error) {
		console.error(error.message);
	} else {
		console.error(error);
	}

	process.exit(1);
});
