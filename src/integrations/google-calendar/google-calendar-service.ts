/** biome-ignore-all lint/style/useConsistentTypeDefinitions: <> */
/** biome-ignore-all assist/source/useSortedKeys: <> */
/** biome-ignore-all assist/source/organizeImports: <> */
/** biome-ignore-all lint/correctness/noUnusedImports: <> */
import { google } from "googleapis";

import { db } from "../../db/connections";
import { googleCalendarConnections } from "../../db/schema/google-calendar-connections";
import { env } from "../../env";

export type BusyPeriod = {
	start: string;
	end: string;
};

export type CalendarAvailability = {
	calendarId: string;
	busy: BusyPeriod[];
};

export type CreateCalendarEventInput = {
	calendarId: string;
	summary: string;
	description?: string;
	start: Date;
	end: Date;
};

export type CreatedCalendarEvent = {
	id: string;
	htmlLink?: string;
	summary?: string;
	start: string;
	end: string;
};

export class GoogleCalendarService {
	private async getCalendarClient() {
		const [connection] = await db
			.select({
				refreshToken: googleCalendarConnections.refreshToken,
			})
			.from(googleCalendarConnections)
			.limit(1);

		if (!connection) {
			throw new Error("Nenhuma conexão Google Calendar encontrada.");
		}

		const oauth2Client = new google.auth.OAuth2(
			env.GOOGLE_CLIENT_ID,
			env.GOOGLE_CLIENT_SECRET,
			env.GOOGLE_REDIRECT_URI
		);

		oauth2Client.setCredentials({
			refresh_token: connection.refreshToken,
		});

		return google.calendar({
			version: "v3",
			auth: oauth2Client,
		});
	}

	async getBusyPeriods(
		calendarIds: string[],
		timeMin: Date,
		timeMax: Date
	): Promise<CalendarAvailability[]> {
		if (calendarIds.length === 0) {
			return [];
		}

		if (timeMin >= timeMax) {
			throw new Error("timeMin deve ser anterior a timeMax.");
		}

		const calendar = await this.getCalendarClient();

		const response = await calendar.freebusy.query({
			requestBody: {
				timeMin: timeMin.toISOString(),
				timeMax: timeMax.toISOString(),
				timeZone: "America/Sao_Paulo",
				items: calendarIds.map((calendarId) => ({
					id: calendarId,
				})),
			},
		});

		return calendarIds.map((calendarId) => {
			const calendarData = response.data.calendars?.[calendarId];

			if (calendarData?.errors?.length) {
				throw new Error(
					`Erro ao consultar calendário ${calendarId}: ${JSON.stringify(
						calendarData.errors
					)}`
				);
			}

			const busy = (calendarData?.busy ?? []).flatMap((period) => {
				if (!(period.start && period.end)) {
					return [];
				}

				return [
					{
						start: period.start,
						end: period.end,
					},
				];
			});

			return {
				calendarId,
				busy,
			};
		});
	}

	async createEvent(
		input: CreateCalendarEventInput
	): Promise<CreatedCalendarEvent> {
		if (input.start >= input.end) {
			throw new Error("O início do evento deve ser anterior ao fim.");
		}

		const calendar = await this.getCalendarClient();

		const response = await calendar.events.insert({
			calendarId: input.calendarId,
			requestBody: {
				summary: input.summary,
				description: input.description,
				start: {
					dateTime: input.start.toISOString(),
					timeZone: "America/Sao_Paulo",
				},
				end: {
					dateTime: input.end.toISOString(),
					timeZone: "America/Sao_Paulo",
				},
			},
		});

		const event = response.data;

		if (!(event.id && event.start?.dateTime && event.end?.dateTime)) {
			throw new Error("Google Calendar não retornou os dados do evento.");
		}

		return {
			id: event.id,
			htmlLink: event.htmlLink ?? undefined,
			summary: event.summary ?? undefined,
			start: event.start.dateTime,
			end: event.end.dateTime,
		};
	}
}
