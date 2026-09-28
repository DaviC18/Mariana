/** biome-ignore-all lint/style/noParameterProperties: <> */

import { and, asc, eq } from "drizzle-orm";

import { db as defaultDb } from "../../db/connections";
import { schedulingSessions, schedulingSlots } from "../../db/schema";
import {
	type SchedulingConfirmationFailureReason,
	SchedulingConfirmationService,
} from "./scheduling-confirmation-service";

export type SchedulingCancellationFailureReason =
	| SchedulingConfirmationFailureReason
	| "invalid_offer"
	| "session_close_failed";

export interface ResolveSchedulingCancellationInput {
	buttonId: string;
	conversationId: string;
	leadId: string;
	now?: Date;
}

export type SchedulingCancellationResult =
	| {
			ok: true;
			action: "reoffer";
			session: typeof schedulingSessions.$inferSelect;
			slots: (typeof schedulingSlots.$inferSelect)[];
	  }
	| {
			ok: true;
			action: "close";
			session: typeof schedulingSessions.$inferSelect;
			slots: (typeof schedulingSlots.$inferSelect)[];
	  }
	| {
			ok: false;
			reason: SchedulingCancellationFailureReason;
	  };

export class SchedulingCancellationService {
	private readonly db: typeof defaultDb;
	private readonly schedulingConfirmationService: SchedulingConfirmationService;

	constructor(
		database = defaultDb,
		schedulingConfirmationService = new SchedulingConfirmationService()
	) {
		this.db = database;
		this.schedulingConfirmationService = schedulingConfirmationService;
	}

	async resolveCancellation({
		buttonId,
		conversationId,
		leadId,
		now = new Date(),
	}: ResolveSchedulingCancellationInput): Promise<SchedulingCancellationResult> {
		const confirmationResult =
			await this.schedulingConfirmationService.resolveConfirmation({
				buttonId,
				conversationId,
				leadId,
				now,
			});

		if (!confirmationResult.ok) {
			return {
				ok: false,
				reason: confirmationResult.reason,
			};
		}

		if (confirmationResult.action !== "cancel") {
			return {
				ok: false,
				reason: "invalid_action",
			};
		}

		const slots = await this.db
			.select()
			.from(schedulingSlots)
			.where(
				eq(schedulingSlots.schedulingSessionId, confirmationResult.session.id)
			)
			.orderBy(asc(schedulingSlots.position));

		if (slots.length < 1 || slots.length > 3) {
			return {
				ok: false,
				reason: "invalid_offer",
			};
		}

		if (slots.length >= 2) {
			return {
				action: "reoffer",
				ok: true,
				session: confirmationResult.session,
				slots,
			};
		}

		const [closedSession] = await this.db
			.update(schedulingSessions)
			.set({
				status: "closed",
				updatedAt: now,
			})
			.where(
				and(
					eq(schedulingSessions.id, confirmationResult.session.id),
					eq(schedulingSessions.leadId, leadId),
					eq(schedulingSessions.status, "active")
				)
			)
			.returning();

		if (!closedSession) {
			return {
				ok: false,
				reason: "session_close_failed",
			};
		}

		return {
			action: "close",
			ok: true,
			session: closedSession,
			slots,
		};
	}
}
