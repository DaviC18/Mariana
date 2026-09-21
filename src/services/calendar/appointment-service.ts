/** biome-ignore-all lint/style/useConsistentTypeDefinitions: <> */
/** biome-ignore-all lint/style/noParameterProperties: <> */

import { and, eq, gt, lt, or } from "drizzle-orm";

import { db } from "../../db/connections";
import { appointments } from "../../db/schema/appointments";
import { consultants } from "../../db/schema/consultants";
import {
	type CreatedCalendarEvent,
	GoogleCalendarService,
} from "../../integrations/google-calendar/google-calendar-service";

export type CreateAppointmentInput = {
	leadId: string;
	consultantId: string;
	startAt: Date;
	endAt: Date;
};

export type CreatedAppointment = {
	appointmentId: string;
	consultantId: string;
	externalEventId: string;
	startAt: Date;
	endAt: Date;
	status: "confirmed";
	calendarEvent: CreatedCalendarEvent;
};

export class AppointmentService {
	constructor(
		private readonly googleCalendarService = new GoogleCalendarService()
	) {}

	async createConfirmedAppointment(
		input: CreateAppointmentInput
	): Promise<CreatedAppointment> {
		if (input.startAt >= input.endAt) {
			throw new Error("O início do agendamento deve ser anterior ao fim.");
		}

		const [consultant] = await db
			.select({
				calendarId: consultants.calendarId,
				id: consultants.id,
				name: consultants.name,
			})
			.from(consultants)
			.where(eq(consultants.id, input.consultantId))
			.limit(1);

		if (!consultant) {
			throw new Error("Consultor não encontrado.");
		}

		const conflictingAppointments = await db
			.select({
				id: appointments.id,
			})
			.from(appointments)
			.where(
				and(
					eq(appointments.consultantId, input.consultantId),
					or(
						eq(appointments.status, "pending_confirmation"),
						eq(appointments.status, "confirmed"),
						eq(appointments.status, "scheduled")
					),
					lt(appointments.startAt, input.endAt),
					gt(appointments.endAt, input.startAt)
				)
			)
			.limit(1);

		if (conflictingAppointments.length > 0) {
			throw new Error("O consultor já possui um agendamento nesse horário.");
		}

		const [calendarAvailability] =
			await this.googleCalendarService.getBusyPeriods(
				[consultant.calendarId],
				input.startAt,
				input.endAt
			);

		if ((calendarAvailability?.busy.length ?? 0) > 0) {
			throw new Error(
				"O horário escolhido não está mais disponível no Google Calendar."
			);
		}

		const calendarEvent = await this.googleCalendarService.createEvent({
			calendarId: consultant.calendarId,
			description: `Agendamento da Mariana para o lead ${input.leadId}.`,
			end: input.endAt,
			start: input.startAt,
			summary: `Atendimento - ${consultant.name}`,
		});

		try {
			const [appointment] = await db
				.insert(appointments)
				.values({
					consultantId: input.consultantId,
					endAt: input.endAt,
					externalEventId: calendarEvent.id,
					leadId: input.leadId,
					startAt: input.startAt,
					status: "confirmed",
				})
				.returning({
					consultantId: appointments.consultantId,
					endAt: appointments.endAt,
					externalEventId: appointments.externalEventId,
					id: appointments.id,
					startAt: appointments.startAt,
					status: appointments.status,
				});

			if (!appointment) {
				throw new Error("Não foi possível salvar o agendamento.");
			}

			return {
				appointmentId: appointment.id,
				calendarEvent,
				consultantId: appointment.consultantId,
				endAt: appointment.endAt,
				externalEventId: appointment.externalEventId,
				startAt: appointment.startAt,
				status: "confirmed",
			};
		} catch (error) {
			try {
				await this.googleCalendarService.deleteEvent(
					consultant.calendarId,
					calendarEvent.id
				);
			} catch {
				// O erro original do banco continua sendo o principal.
			}

			throw error;
		}
	}
}
