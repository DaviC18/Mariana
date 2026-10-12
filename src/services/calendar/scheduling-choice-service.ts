import { and, eq, gt, isNull, or } from "drizzle-orm";
import { z } from "zod";

import { db as defaultDb } from "../../db/connections";
import { schedulingSessions, type schedulingSlots } from "../../db/schema";

const buttonIdSchema = z.string().uuid();

export type SchedulingChoiceFailureReason =
	| "invalid_button"
	| "invalid_slot"
	| "no_active_session"
	| "expired"
	| "slot_not_selected"
	| "selection_already_made"
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
	private readonly db: typeof defaultDb;

	constructor(database = defaultDb) {
		this.db = database;
	}

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

		const slot = await this.db.query.schedulingSlots.findFirst({
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

		const session = await this.db.query.schedulingSessions.findFirst({
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

		const [selectedSession] = await this.db
			.update(schedulingSessions)
			.set({
				selectedSlotId: slot.id,
				updatedAt: now,
			})
			.where(
				and(
					eq(schedulingSessions.id, session.id),
					eq(schedulingSessions.leadId, input.leadId),
					eq(schedulingSessions.conversationId, input.conversationId),
					eq(schedulingSessions.status, "active"),
					gt(schedulingSessions.expiresAt, now),
					or(
						isNull(schedulingSessions.selectedSlotId),
						eq(schedulingSessions.selectedSlotId, slot.id)
					)
				)
			)
			.returning();

		if (!selectedSession) {
			return {
				ok: false,
				reason: "selection_already_made",
			};
		}

		return {
			ok: true,
			session: selectedSession,
			slot,
		};
	}

	async resolveSelectedChoice(
		input: ResolveSchedulingChoiceInput
	): Promise<SchedulingChoiceResult> {
		const result = await this.resolveExistingChoice(input);

		if (!result.ok) {
			return result;
		}

		if (result.session.selectedSlotId !== result.slot.id) {
			return {
				ok: false,
				reason: "slot_not_selected",
			};
		}

		return result;
	}

	private async resolveExistingChoice(
		input: ResolveSchedulingChoiceInput
	): Promise<SchedulingChoiceResult> {
		const parsedButtonId = buttonIdSchema.safeParse(input.buttonId);

		if (!parsedButtonId.success) {
			return { ok: false, reason: "invalid_button" };
		}

		const now = input.now ?? new Date();
		const slot = await this.db.query.schedulingSlots.findFirst({
			where: { id: parsedButtonId.data },
		});

		if (!slot) {
			return { ok: false, reason: "invalid_slot" };
		}

		const session = await this.db.query.schedulingSessions.findFirst({
			where: { id: slot.schedulingSessionId },
		});

		if (session?.status !== "active") {
			return { ok: false, reason: "no_active_session" };
		}

		if (
			session.leadId !== input.leadId ||
			session.conversationId !== input.conversationId
		) {
			return { ok: false, reason: "slot_from_another_session" };
		}

		if (session.expiresAt <= now) {
			return { ok: false, reason: "expired" };
		}

		return { ok: true, session, slot };
	}
}
