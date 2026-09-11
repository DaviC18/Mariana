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
] as const;

export type NextAction = MarianaResponse["nextAction"];

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

	if (!resolvedConversationId) {
		throw new Error("Conversation id is required");
	}

	console.info({
		conversationId: resolvedConversationId,
		event: "agent_action_started",
		leadId,
		nextAction,
	});

	if (nextAction === "continue_qualification") {
		console.info({
			conversationId: resolvedConversationId,
			event: "agent_action_executed",
			leadId,
			nextAction,
		});

		return {
			action: "continue_qualification",
			status: "executed",
		};
	}

	if (nextAction === "offer_meeting") {
		console.info({
			conversationId: resolvedConversationId,
			event: "agent_action_executed",
			leadId,
			nextAction,
		});

		return {
			action: "offer_meeting",
			status: "executed",
		};
	}

	if (nextAction === "schedule_meeting") {
		console.info({
			conversationId: resolvedConversationId,
			event: "agent_action_pending",
			leadId,
			nextAction,
		});

		return {
			action: "schedule_meeting",
			status: "pending",
		};
	}

	if (nextAction === "close") {
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
