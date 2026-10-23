/** biome-ignore-all lint/suspicious/useAwait: <> */
/** biome-ignore-all lint/performance/useTopLevelRegex: <> */
/** biome-ignore-all lint/performance/noAwaitInLoops: <> */
// Replays scripted conversations through the real generateMarianaResponse
// path on the local test database. Gemini is mocked at the client
// (`ai.models.generateContent`), so prompt building, safety checks and
// commercial policy run for real. Google Calendar is mocked through the
// ConsultantAvailabilityService. WhatsApp is never called.
import assert from "node:assert/strict";

import { asc, eq } from "drizzle-orm";

import { ai } from "../../ai/client";
import type { MarianaResponse } from "../../ai/schemas/mariana-response-schema";
import { db } from "../../db/connections";
import {
	appointments,
	consultants,
	conversations,
	leads,
	messages,
	schedulingSessions,
} from "../../db/schema";
import type {
	ConsultantAvailabilityService,
	ConsultantAvailableSlot,
} from "../../services/calendar/consultant-availability";
import { SchedulingAvailabilityService } from "../../services/calendar/scheduling-availability";
import {
	type GenerateMarianaResponseResult,
	generateMarianaResponse,
} from "../../services/conversations/generateMarianaResponse";

export type ScriptedGeminiResult = Omit<MarianaResponse, "nextAction"> & {
	nextAction?: MarianaResponse["nextAction"];
};

export interface ScriptedTurn {
	gemini: ScriptedGeminiResult;
	user: string[];
}

export interface RecordedTurn {
	assistant: string;
	result: GenerateMarianaResponseResult;
	systemPrompt: string;
	user: string[];
}

let generateContentInstalled = false;
const pendingGeminiResults: ScriptedGeminiResult[] = [];
const recordedPrompts: string[] = [];

// Replaces the Gemini client once per process. Each call consumes the next
// scripted result; an unexpected call fails loudly.
export function installScriptedGemini(): void {
	if (generateContentInstalled) {
		return;
	}
	generateContentInstalled = true;

	(
		ai.models as unknown as {
			generateContent: (params: {
				config?: { systemInstruction?: unknown };
			}) => Promise<unknown>;
		}
	).generateContent = async (params) => {
		const next = pendingGeminiResults.shift();
		if (!next) {
			throw new Error("Gemini mock called without a scripted result");
		}
		recordedPrompts.push(String(params.config?.systemInstruction ?? ""));

		return {
			modelVersion: "scripted-gemini",
			text: JSON.stringify({
				nextAction: "continue_qualification",
				...next,
			}),
			usageMetadata: undefined,
		};
	};
}

export async function listActiveConsultants() {
	return await db
		.select({
			calendarId: consultants.calendarId,
			id: consultants.id,
			name: consultants.name,
		})
		.from(consultants)
		.where(eq(consultants.active, true));
}

// Calendar mock: three fixed free slots in the near future, one per
// consultant, so no real Google Calendar is ever touched.
export function buildFakeAvailabilityService(calls: { count: number }) {
	const fakeConsultantAvailability = {
		getAvailableConsultants: async (
			rankedConsultants: { calendarId: string; id: string; name: string }[],
			timeMin: Date
		): Promise<ConsultantAvailableSlot[]> => {
			calls.count += 1;
			return rankedConsultants.slice(0, 3).map((consultant, index) => {
				const start = new Date(timeMin.getTime() + (index + 1) * 3_600_000);
				start.setUTCMinutes(0, 0, 0);
				return {
					consultant,
					end: new Date(start.getTime() + 30 * 60_000),
					start,
				};
			});
		},
	} as unknown as ConsultantAvailabilityService;

	return new SchedulingAvailabilityService(fakeConsultantAvailability);
}

export async function createConversationFixture({
	birthDate,
	name,
}: {
	birthDate?: Date;
	name?: string;
} = {}) {
	const phone = `5511${Math.floor(Math.random() * 1e9)
		.toString()
		.padStart(9, "0")}`;
	const [lead] = await db
		.insert(leads)
		.values({
			birthDate,
			name: name ?? phone,
			phone,
			status: "new",
		})
		.returning({ id: leads.id });
	assert.ok(lead);

	const [conversation] = await db
		.insert(conversations)
		.values({ leadId: lead.id })
		.returning({ id: conversations.id });
	assert.ok(conversation);

	return { conversationId: conversation.id, leadId: lead.id };
}

export async function cleanupConversationFixture(leadId: string) {
	await db.delete(appointments).where(eq(appointments.leadId, leadId));
	await db
		.delete(schedulingSessions)
		.where(eq(schedulingSessions.leadId, leadId));
	await db.delete(leads).where(eq(leads.id, leadId));
}

export async function runScriptedConversation({
	leadId,
	schedulingAvailabilityService,
	turns,
}: {
	leadId: string;
	schedulingAvailabilityService: SchedulingAvailabilityService;
	turns: ScriptedTurn[];
}): Promise<RecordedTurn[]> {
	installScriptedGemini();
	const recorded: RecordedTurn[] = [];

	for (const turn of turns) {
		pendingGeminiResults.length = 0;
		recordedPrompts.length = 0;
		pendingGeminiResults.push(turn.gemini);

		const result = await generateMarianaResponse({
			currentMessages: turn.user,
			leadId,
			schedulingAvailabilityService,
		});

		recorded.push({
			assistant: result.result.reply,
			result,
			systemPrompt: recordedPrompts.at(-1) ?? "",
			user: turn.user,
		});

		// A scheduling offer ends the scripted text conversation.
		if (result.schedulingOffer) {
			break;
		}
	}

	pendingGeminiResults.length = 0;
	return recorded;
}

export async function seedHistory(
	conversationId: string,
	history: { content: string; role: "assistant" | "user" }[]
) {
	const base = Date.now() - 10 * 60_000;
	await db.insert(messages).values(
		history.map((message, index) => ({
			...message,
			conversationId,
			createdAt: new Date(base + index * 1000),
		}))
	);
}

export async function updateLeadFixture(
	leadId: string,
	values: Partial<typeof leads.$inferInsert>
) {
	await db.update(leads).set(values).where(eq(leads.id, leadId));
}

export async function loadLead(leadId: string) {
	const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
	assert.ok(lead);
	return lead;
}

export async function loadAssistantMessages(conversationId: string) {
	const rows = await db
		.select({ content: messages.content, role: messages.role })
		.from(messages)
		.where(eq(messages.conversationId, conversationId))
		.orderBy(asc(messages.createdAt));
	return rows
		.filter((row) => row.role === "assistant")
		.map((row) => row.content);
}
