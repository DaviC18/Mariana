import { z } from "zod";

import { db } from "../../db/connections";
import type { schedulingSessions, schedulingSlots } from "../../db/schema";

const buttonIdSchema = z.string().uuid();

export type SchedulingChoiceFailureReason =
	| "invalid_button"
	| "invalid_slot"
	| "no_active_session"
	| "expired"
	| "slot_from_another_session";

export type SchedulingChoiceResult =
	| {
			ok: true;
			slot: typeof schedulingSlots.$inferSelect;
			session: typeof schedulingSessions.$inferSelect;
	  }
	| {
			ok: false;
			reason: SchedulingChoiceFailureReason;
	  };

export interface ResolveSchedulingChoiceInput {
	buttonId: string;
	conversationId: string;
	leadId: string;
	now?: Date;
}

export class SchedulingChoiceService {
	async resolveChoice(
		input: ResolveSchedulingChoiceInput
	): Promise<SchedulingChoiceResult> {
		const parsedButtonId = buttonIdSchema.safeParse(input.buttonId);

		if (!parsedButtonId.success) {
			return {
				ok: false,
				reason: "invalid_button",
			};
		}

		const now = input.now ?? new Date();

		const slot = await db.query.schedulingSlots.findFirst({
			where: {
				id: parsedButtonId.data,
			},
		});

		if (!slot) {
			return {
				ok: false,
				reason: "invalid_slot",
			};
		}

		const session = await db.query.schedulingSessions.findFirst({
			where: {
				id: slot.schedulingSessionId,
			},
		});

		if (!session) {
			return {
				ok: false,
				reason: "no_active_session",
			};
		}

		if (
			session.leadId !== input.leadId ||
			session.conversationId !== input.conversationId
		) {
			return {
				ok: false,
				reason: "slot_from_another_session",
			};
		}

		if (session.status !== "active") {
			return {
				ok: false,
				reason: "no_active_session",
			};
		}

		if (session.expiresAt <= now) {
			return {
				ok: false,
				reason: "expired",
			};
		}

		return {
			ok: true,
			session,
			slot,
		};
	}
}
