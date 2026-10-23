/** biome-ignore-all lint/style/noParameterProperties: <> */

import { and, eq } from "drizzle-orm";

import { db } from "../../db/connections";
import {
	appointments,
	schedulingSessions,
	schedulingSlots,
} from "../../db/schema";

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

const CONFIRM_BUTTON_ID =
	/^confirm:([\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12})$/i;

function buildAppointmentIdempotencyKey(sessionId: string, slotId: string) {
	return `appointment:${sessionId}:${slotId}`;
}

/**
 * Uma confirmação já concluída fecha a sessão; se a tarefa for repetida (por
 * exemplo, porque o outbox falhou depois do appointment), a validação normal
 * rejeita a sessão fechada. Nesse caso devolve o appointment que esta mesma
 * confirmação criou, para que a mensagem de confirmação ainda seja enviada,
 * sem criar outro evento no calendário.
 */
async function findConfirmedReplay(
	input: ExecuteSchedulingConfirmationInput
): Promise<SchedulingConfirmationOrchestratorResult | undefined> {
	const slotId = CONFIRM_BUTTON_ID.exec(input.buttonId)?.[1];
	if (!slotId) {
		return;
	}

	const [selection] = await db
		.select({ session: schedulingSessions, slot: schedulingSlots })
		.from(schedulingSlots)
		.innerJoin(
			schedulingSessions,
			eq(schedulingSessions.id, schedulingSlots.schedulingSessionId)
		)
		.where(
			and(
				eq(schedulingSlots.id, slotId),
				eq(schedulingSessions.leadId, input.leadId),
				eq(schedulingSessions.conversationId, input.conversationId),
				eq(schedulingSessions.selectedSlotId, slotId),
				eq(schedulingSessions.status, "closed")
			)
		)
		.limit(1);

	if (!selection) {
		return;
	}

	const [appointment] = await db
		.select()
		.from(appointments)
		.where(
			and(
				eq(
					appointments.idempotencyKey,
					buildAppointmentIdempotencyKey(selection.session.id, slotId)
				),
				eq(appointments.leadId, input.leadId)
			)
		)
		.limit(1);

	if (!appointment) {
		return;
	}

	return {
		action: "confirm",
		appointment: {
			appointmentId: appointment.id,
			calendarEvent: {
				end: appointment.endAt.toISOString(),
				id: appointment.externalEventId,
				start: appointment.startAt.toISOString(),
			},
			consultantId: appointment.consultantId,
			endAt: appointment.endAt,
			externalEventId: appointment.externalEventId,
			startAt: appointment.startAt,
			status: "confirmed",
		},
		ok: true,
		session: selection.session,
		slot: selection.slot,
	};
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
			const replay = await findConfirmedReplay(input);
			if (replay) {
				return replay;
			}

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
					idempotencyKey: buildAppointmentIdempotencyKey(
						confirmationResult.session.id,
						confirmationResult.slot.id
					),
					leadId: input.leadId,
					now: input.now,
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
