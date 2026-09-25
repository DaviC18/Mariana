import { z } from "zod";

import type { schedulingSessions, schedulingSlots } from "../../db/schema";
import { formatSlotDate } from "../../utils/date-formatter";
import {
	type SchedulingChoiceFailureReason,
	SchedulingChoiceService,
} from "./scheduling-choice-service";

const confirmationActionSchema = z.enum(["confirm", "cancel"]);
const slotIdSchema = z.string().uuid();

export type SchedulingConfirmationAction = "confirm" | "cancel";

export type SchedulingConfirmationFailureReason =
	| "invalid_action"
	| "invalid_slot"
	| SchedulingChoiceFailureReason;

export type SchedulingConfirmationResult =
	| {
			ok: true;
			action: SchedulingConfirmationAction;
			slot: typeof schedulingSlots.$inferSelect;
			session: typeof schedulingSessions.$inferSelect;
	  }
	| {
			ok: false;
			reason: SchedulingConfirmationFailureReason;
	  };

export interface ResolveSchedulingConfirmationInput {
	buttonId: string;
	conversationId: string;
	leadId: string;
	now?: Date;
}

export interface SchedulingConfirmationMessage {
	body: string;
	buttons: Array<{
		id: string;
		title: string;
	}>;
}

export class SchedulingConfirmationService {
	private readonly schedulingChoiceService: SchedulingChoiceService;

	constructor(schedulingChoiceService = new SchedulingChoiceService()) {
		this.schedulingChoiceService = schedulingChoiceService;
	}

	resolveAction(buttonId: string):
		| {
				ok: true;
				action: SchedulingConfirmationAction;
				slotId: string;
		  }
		| {
				ok: false;
				reason: "invalid_action" | "invalid_slot";
		  } {
		const separatorIndex = buttonId.indexOf(":");

		if (separatorIndex === -1) {
			return {
				ok: false,
				reason: "invalid_action",
			};
		}

		const rawAction = buttonId.slice(0, separatorIndex);
		const rawSlotId = buttonId.slice(separatorIndex + 1);

		const parsedAction = confirmationActionSchema.safeParse(rawAction);

		if (!parsedAction.success) {
			return {
				ok: false,
				reason: "invalid_action",
			};
		}

		const parsedSlotId = slotIdSchema.safeParse(rawSlotId);

		if (!parsedSlotId.success) {
			return {
				ok: false,
				reason: "invalid_slot",
			};
		}

		return {
			action: parsedAction.data,
			ok: true,
			slotId: parsedSlotId.data,
		};
	}

	buildConfirmationMessage(slot: {
		id: string;
		startAt: Date;
		consultantName: string;
	}): SchedulingConfirmationMessage {
		const formattedDate = formatSlotDate(slot.startAt);

		return {
			body: `Você escolheu ${formattedDate} com ${slot.consultantName}. Posso confirmar?`,
			buttons: [
				{
					id: `confirm:${slot.id}`,
					title: "Confirmar",
				},
				{
					id: `cancel:${slot.id}`,
					title: "Não",
				},
			],
		};
	}

	async resolveConfirmation(
		input: ResolveSchedulingConfirmationInput
	): Promise<SchedulingConfirmationResult> {
		const actionResult = this.resolveAction(input.buttonId);

		if (!actionResult.ok) {
			return actionResult;
		}

		const choiceResult = await this.schedulingChoiceService.resolveChoice({
			buttonId: actionResult.slotId,
			conversationId: input.conversationId,
			leadId: input.leadId,
			now: input.now,
		});

		if (!choiceResult.ok) {
			return {
				ok: false,
				reason: choiceResult.reason,
			};
		}

		return {
			action: actionResult.action,
			ok: true,
			session: choiceResult.session,
			slot: choiceResult.slot,
		};
	}
}
