import { and, eq, inArray } from "drizzle-orm";

import { db as database } from "../../db/connections";
import { appointments, consultants, leads } from "../../db/schema";
import { AGENDA_OCCUPYING_APPOINTMENT_STATUSES } from "../appointments/appointment-status";
import { buildConsultantLoads } from "../consultants/consultant-load";
import {
	ConsultantAvailabilityService,
	type ConsultantAvailableSlot,
} from "./consultant-availability";

export class SchedulingAvailabilityError extends Error {
	readonly code: "invalid_time_range" | "lead_not_found" | "lead_not_qualified";

	constructor(
		code: "invalid_time_range" | "lead_not_found" | "lead_not_qualified",
		message: string
	) {
		super(message);
		this.code = code;
	}
}

export class SchedulingAvailabilityService {
	private readonly consultantAvailabilityService: ConsultantAvailabilityService;

	constructor(
		consultantAvailabilityService = new ConsultantAvailabilityService()
	) {
		this.consultantAvailabilityService = consultantAvailabilityService;
	}

	async getAvailableSlots({
		leadId,
		timeMax,
		timeMin,
	}: {
		leadId: string;
		timeMin: Date;
		timeMax: Date;
	}): Promise<ConsultantAvailableSlot[]> {
		if (timeMin >= timeMax) {
			throw new SchedulingAvailabilityError(
				"invalid_time_range",
				"timeMin deve ser anterior a timeMax."
			);
		}

		const [lead] = await database
			.select({ id: leads.id, status: leads.status })
			.from(leads)
			.where(eq(leads.id, leadId))
			.limit(1);

		if (!lead) {
			throw new SchedulingAvailabilityError(
				"lead_not_found",
				"Lead não encontrado."
			);
		}

		if (lead.status !== "qualified") {
			throw new SchedulingAvailabilityError(
				"lead_not_qualified",
				"O lead precisa estar qualificado para consultar horários."
			);
		}

		const activeConsultants = await database
			.select({
				calendarId: consultants.calendarId,
				id: consultants.id,
				name: consultants.name,
			})
			.from(consultants)
			.where(eq(consultants.active, true));

		if (activeConsultants.length === 0) {
			return [];
		}

		const activeAppointments = await database
			.select({
				consultantId: appointments.consultantId,
				status: appointments.status,
			})
			.from(appointments)
			.where(
				and(
					inArray(
						appointments.consultantId,
						activeConsultants.map((consultant) => consultant.id)
					),
					inArray(appointments.status, AGENDA_OCCUPYING_APPOINTMENT_STATUSES)
				)
			);

		const loads = buildConsultantLoads(activeAppointments);
		const rankedConsultants = [...activeConsultants].sort(
			(left, right) =>
				(loads[left.id] ?? 0) - (loads[right.id] ?? 0) ||
				left.name.localeCompare(right.name, "pt-BR")
		);

		return this.consultantAvailabilityService.getAvailableConsultants(
			rankedConsultants,
			timeMin,
			timeMax
		);
	}
}
