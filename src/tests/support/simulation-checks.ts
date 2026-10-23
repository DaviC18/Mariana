/** biome-ignore-all lint/performance/useTopLevelRegex: <> */
// Pure checks shared by the transcript tests and the opt-in conversation
// simulator (scripts/simulate-conversation.ts).
import {
	findAskedQuestion,
	type StageQuestionKey,
} from "../../services/conversations/conversation-stage";

export interface KnownFields {
	currentSituation: boolean;
	interestedInConsultant: boolean;
	name: boolean;
	objective: boolean;
	painPoint: boolean;
}

export interface SimulatedTurn {
	/** Lead state after the turn: a question about a known field is a re-ask. */
	known: KnownFields;
	offered: boolean;
	reply: string;
	user: string[];
}

const QUESTION_FIELD: Record<StageQuestionKey, keyof KnownFields> = {
	consultantOffer: "interestedInConsultant",
	consultantReason: "objective",
	currentSituation: "currentSituation",
	name: "name",
	painPoint: "painPoint",
	reason: "objective",
};

// Sentences of a conversational reply. Numbered slot lines are data, not
// sentences.
export function countSentences(reply: string): number {
	return reply
		.split("\n")
		.filter((line) => !/^\s*\d+\.\s/.test(line))
		.join(" ")
		.split(/(?<=[.!?])\s+/)
		.map((part) => part.trim())
		.filter((part) => /[\p{L}\p{N}]/u.test(part)).length;
}

export function questionSentences(reply: string): string[] {
	return reply
		.split(/(?<=[.!?])\s+|\n+/)
		.map((part) => part.trim())
		.filter((part) => part.endsWith("?"));
}

function numbersIn(text: string): string[] {
	return text.match(/\d+(?:[.,]\d+)*/g) ?? [];
}

function checkReply(
	label: string,
	turn: SimulatedTurn,
	seenQuestions: Set<string>,
	clientNumbers: Set<string>
): string[] {
	const failures: string[] = [];

	for (const question of questionSentences(turn.reply)) {
		if (seenQuestions.has(question)) {
			failures.push(`${label}: repeated question "${question}"`);
		}
		seenQuestions.add(question);

		const key = findAskedQuestion(question);
		if (key && turn.known[QUESTION_FIELD[key]]) {
			failures.push(`${label}: re-asked answered field (${key}) "${question}"`);
		}
	}

	const invented = numbersIn(turn.reply).filter(
		(value) => !clientNumbers.has(value)
	);
	if (invented.length > 0 || turn.reply.includes("%")) {
		failures.push(
			`${label}: sensitive number not stated by the client (${invented.join(", ") || "%"})`
		);
	}

	if (countSentences(turn.reply) > 3) {
		failures.push(`${label}: more than 3 sentences`);
	}
	if ((turn.reply.match(/\?/g) ?? []).length > 1) {
		failures.push(`${label}: more than 1 questions`);
	}

	return failures;
}

export function evaluateSimulatedConversation({
	offerWithinTurns,
	turns,
}: {
	offerWithinTurns: number;
	turns: SimulatedTurn[];
}): string[] {
	const failures: string[] = [];
	const offerIndex = turns.findIndex((turn) => turn.offered);

	if (offerIndex === -1 || offerIndex >= offerWithinTurns) {
		failures.push(
			`offer flow did not start within ${offerWithinTurns} turns (started at ${offerIndex === -1 ? "never" : offerIndex + 1})`
		);
	}

	const seenQuestions = new Set<string>();
	const clientNumbers = new Set<string>();

	for (const [index, turn] of turns.entries()) {
		for (const value of turn.user.flatMap(numbersIn)) {
			clientNumbers.add(value);
		}
		// Slot offers are backend data (dates and times), not conversation.
		if (!turn.offered) {
			failures.push(
				...checkReply(`turn ${index + 1}`, turn, seenQuestions, clientNumbers)
			);
		}
	}

	return failures;
}
