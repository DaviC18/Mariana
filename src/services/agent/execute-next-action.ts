/** biome-ignore-all lint/style/useFilenamingConvention: <> */

import { eq } from "drizzle-orm";

import type { MarianaResponse } from "../../ai/schemas/mariana-response-schema";
import { db } from "../../db/connections";
import { conversations } from "../../db/schema";

export const NEXT_ACTIONS = [
	"continue_qualification",
	"offer_meeting",
	"schedule_meeting",
	"close",
	"answer_basic_question",
	"answer_with_more_detail",
	"ask_next_qualification_question",
	"request_consultant",
	"offer_appointment",
	"wait_for_schedule",
	"close_conversation",
	"reject_out_of_scope",
] as const;

export type MarianaNextAction =
	| "answer_basic_question"
	| "answer_with_more_detail"
	| "ask_next_qualification_question"
	| "request_consultant"
	| "offer_appointment"
	| "wait_for_schedule"
	| "close_conversation"
	| "reject_out_of_scope"
	| MarianaResponse["nextAction"];

export type NextAction = MarianaNextAction;

const ACTION_ALIASES: Record<MarianaNextAction, MarianaResponse["nextAction"]> =
	{
		answer_basic_question: "continue_qualification",
		answer_with_more_detail: "continue_qualification",
		ask_next_qualification_question: "continue_qualification",
		close: "close",
		close_conversation: "close",
		continue_qualification: "continue_qualification",

		offer_appointment: "offer_meeting",

		offer_meeting: "offer_meeting",
		reject_out_of_scope: "close",
		request_consultant: "offer_meeting",
		schedule_meeting: "schedule_meeting",
		wait_for_schedule: "schedule_meeting",
	};

export type ExecuteNextActionResult =
	| {
			action: "continue_qualification";
			status: "executed";
	  }
	| {
			action: "offer_meeting";
			status: "executed";
	  }
	| {
			action: "schedule_meeting";
			status: "pending";
	  }
	| {
			action: "close";
			status: "executed";
	  };

export interface ExecuteNextActionParams {
	conversationId: string;
	leadId: string;
	nextAction: NextAction;
	persistConversationStatus?: (input: {
		conversationId: string;
		status: "closed";
		updatedAt: Date;
	}) => Promise<{ id: string }>;
}

export async function executeNextAction({
	conversationId,
	leadId,
	nextAction,
	persistConversationStatus = async ({
		conversationId: targetConversationId,
	}) => {
		const [updatedConversation] = await db
			.update(conversations)
			.set({
				status: "closed",
				updatedAt: new Date(),
			})
			.where(eq(conversations.id, targetConversationId))
			.returning();

		if (!updatedConversation) {
			throw new Error("Conversation not found");
		}

		return updatedConversation;
	},
}: ExecuteNextActionParams): Promise<ExecuteNextActionResult> {
	const resolvedConversationId = conversationId;
	const normalizedAction =
		ACTION_ALIASES[nextAction as MarianaNextAction] ?? nextAction;

	if (!resolvedConversationId) {
		throw new Error("Conversation id is required");
	}

	console.info({
		conversationId: resolvedConversationId,
		event: "agent_action_started",
		leadId,
		nextAction: normalizedAction,
	});

	if (normalizedAction === "continue_qualification") {
		console.info({
			conversationId: resolvedConversationId,
			event: "agent_action_executed",
			leadId,
			nextAction: normalizedAction,
		});

		return {
			action: "continue_qualification",
			status: "executed",
		};
	}

	if (normalizedAction === "offer_meeting") {
		console.info({
			conversationId: resolvedConversationId,
			event: "agent_action_executed",
			leadId,
			nextAction: normalizedAction,
		});

		return {
			action: "offer_meeting",
			status: "executed",
		};
	}

	if (normalizedAction === "schedule_meeting") {
		console.info({
			conversationId: resolvedConversationId,
			event: "agent_action_pending",
			leadId,
			nextAction: normalizedAction,
		});

		return {
			action: "schedule_meeting",
			status: "pending",
		};
	}

	if (normalizedAction === "close") {
		await persistConversationStatus({
			conversationId: resolvedConversationId,
			status: "closed",
			updatedAt: new Date(),
		});

		console.info({
			conversationId: resolvedConversationId,
			event: "conversation_closed",
			leadId,
		});

		return {
			action: "close",
			status: "executed",
		};
	}

	throw new Error(`Unsupported next action: ${String(nextAction)}`);
}
