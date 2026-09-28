/** biome-ignore-all lint/style/noParameterProperties: <> */

import type { schedulingSessions, schedulingSlots } from "../../db/schema";

import {
	AppointmentService,
	type CreatedAppointment,
} from "./appointment-service";

import {
	type SchedulingConfirmationFailureReason,
	SchedulingConfirmationService,
} from "./scheduling-confirmation-service";

export type SchedulingConfirmationOrchestratorResult =
	| {
			ok: true;
			action: "confirm";
			appointment: CreatedAppointment;
			session: typeof schedulingSessions.$inferSelect;
			slot: typeof schedulingSlots.$inferSelect;
	  }
	| {
			ok: true;
			action: "cancel";
			session: typeof schedulingSessions.$inferSelect;
			slot: typeof schedulingSlots.$inferSelect;
	  }
	| {
			ok: false;
			reason: SchedulingConfirmationFailureReason | "appointment_failed";
	  };

export interface ExecuteSchedulingConfirmationInput {
	buttonId: string;
	conversationId: string;
	leadId: string;
	now?: Date;
}

export class SchedulingConfirmationOrchestrator {
	constructor(
		private readonly schedulingConfirmationService = new SchedulingConfirmationService(),
		private readonly appointmentService = new AppointmentService()
	) {}

	async execute(
		input: ExecuteSchedulingConfirmationInput
	): Promise<SchedulingConfirmationOrchestratorResult> {
		const confirmationResult =
			await this.schedulingConfirmationService.resolveConfirmation(input);

		if (!confirmationResult.ok) {
			return {
				ok: false,
				reason: confirmationResult.reason,
			};
		}

		if (confirmationResult.action === "cancel") {
			return {
				action: "cancel",
				ok: true,
				session: confirmationResult.session,
				slot: confirmationResult.slot,
			};
		}

		try {
			const appointment =
				await this.appointmentService.createConfirmedAppointment({
					consultantId: confirmationResult.slot.consultantId,
					endAt: confirmationResult.slot.endAt,
					leadId: input.leadId,
					schedulingSessionId: confirmationResult.session.id,
					startAt: confirmationResult.slot.startAt,
				});

			return {
				action: "confirm",
				appointment,
				ok: true,
				session: confirmationResult.session,
				slot: confirmationResult.slot,
			};
		} catch {
			return {
				ok: false,
				reason: "appointment_failed",
			};
		}
	}
}
