/** biome-ignore-all lint/style/noParameterProperties: <> */

import { and, eq, gt, inArray, lt } from "drizzle-orm";

import { db } from "../../db/connections";
import { appointments, consultants, leads } from "../../db/schema";
import {
	type CreatedCalendarEvent,
	GoogleCalendarService,
} from "../../integrations/google-calendar/google-calendar-service";
import { AGENDA_OCCUPYING_APPOINTMENT_STATUSES } from "../appointments/appointment-status";

export interface CreateAppointmentInput {
	consultantId: string;
	endAt: Date;
	leadId: string;
	startAt: Date;
}

export interface CreatedAppointment {
	appointmentId: string;
	calendarEvent: CreatedCalendarEvent;
	consultantId: string;
	endAt: Date;
	externalEventId: string;
	startAt: Date;
	status: "confirmed";
}

export class AppointmentServiceError extends Error {
	readonly code:
		| "consultant_inactive"
		| "consultant_not_found"
		| "invalid_time_range"
		| "lead_not_found"
		| "lead_not_qualified"
		| "slot_unavailable";

	constructor(
		code:
			| "consultant_inactive"
			| "consultant_not_found"
			| "invalid_time_range"
			| "lead_not_found"
			| "lead_not_qualified"
			| "slot_unavailable",
		message: string
	) {
		super(message);
		this.code = code;
		this.name = "AppointmentServiceError";
	}
}

export class AppointmentService {
	private readonly googleCalendarService: GoogleCalendarService;

	constructor(googleCalendarService = new GoogleCalendarService()) {
		this.googleCalendarService = googleCalendarService;
	}

	async createConfirmedAppointment(
		input: CreateAppointmentInput
	): Promise<CreatedAppointment> {
		if (input.startAt >= input.endAt) {
			throw new AppointmentServiceError(
				"invalid_time_range",
				"O início do agendamento deve ser anterior ao fim."
			);
		}

		const [consultant] = await db
			.select({
				active: consultants.active,
				calendarId: consultants.calendarId,
				id: consultants.id,
				name: consultants.name,
			})
			.from(consultants)
			.where(eq(consultants.id, input.consultantId))
			.limit(1);

		if (!consultant) {
			throw new AppointmentServiceError(
				"consultant_not_found",
				"Consultor não encontrado."
			);
		}

		if (!consultant.active) {
			throw new AppointmentServiceError(
				"consultant_inactive",
				"Consultor indisponível para agendamento."
			);
		}

		const [lead] = await db
			.select({ id: leads.id, status: leads.status })
			.from(leads)
			.where(eq(leads.id, input.leadId))
			.limit(1);

		if (!lead) {
			throw new AppointmentServiceError(
				"lead_not_found",
				"Lead não encontrado."
			);
		}

		if (lead.status !== "qualified") {
			throw new AppointmentServiceError(
				"lead_not_qualified",
				"O lead precisa estar qualificado antes do agendamento."
			);
		}

		const [conflictingAppointment] = await db
			.select({ id: appointments.id })
			.from(appointments)
			.where(
				and(
					eq(appointments.consultantId, input.consultantId),
					inArray(appointments.status, AGENDA_OCCUPYING_APPOINTMENT_STATUSES),
					lt(appointments.startAt, input.endAt),
					gt(appointments.endAt, input.startAt)
				)
			)
			.limit(1);

		if (conflictingAppointment) {
			throw new AppointmentServiceError(
				"slot_unavailable",
				"O consultor já possui um agendamento nesse horário."
			);
		}

		const [calendarAvailability] =
			await this.googleCalendarService.getBusyPeriods(
				[consultant.calendarId],
				input.startAt,
				input.endAt
			);

		if ((calendarAvailability?.busy.length ?? 0) > 0) {
			throw new AppointmentServiceError(
				"slot_unavailable",
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
			const appointment = await db.transaction(async (tx) => {
				const [createdAppointment] = await tx
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

				if (!createdAppointment) {
					throw new Error("Não foi possível salvar o agendamento.");
				}

				const [scheduledLead] = await tx
					.update(leads)
					.set({ status: "scheduled", updatedAt: new Date() })
					.where(and(eq(leads.id, input.leadId), eq(leads.status, "qualified")))
					.returning({ id: leads.id });

				if (!scheduledLead) {
					throw new AppointmentServiceError(
						"lead_not_qualified",
						"O lead não está mais qualificado para agendamento."
					);
				}

				return createdAppointment;
			});

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
				// The original persistence error remains the actionable error.
			}

			throw error;
		}
	}
}
