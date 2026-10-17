/** biome-ignore-all lint/performance/noAwaitInLoops: <> */
/** biome-ignore-all lint/suspicious/useAwait: <> */
// Opt-in conversation simulator. Runs scripted client messages through the
// REAL generateMarianaResponse path (real Gemini) on the local test database.
// WhatsApp and Google Calendar are stubbed; nothing is sent to a client and
// no Calendar event or OAuth token is ever touched.
// Entry point: scripts/simulate-conversation.ts (`npm run sim:conversation`).

import { GoogleCalendarService } from "../../integrations/google-calendar/google-calendar-service";
import { WhatsAppService } from "../../integrations/whatsapp/whatsapp-service";
import { isNameKnown } from "../../services/conversations/conversation-stage";
import { generateMarianaResponse } from "../../services/conversations/generateMarianaResponse";
import {
	buildFakeAvailabilityService,
	cleanupConversationFixture,
	createConversationFixture,
	loadLead,
} from "./conversation-harness";
import {
	evaluateSimulatedConversation,
	type SimulatedTurn,
} from "./simulation-checks";

export interface SimulationScenario {
	id: string;
	leadName?: string;
	offerWithinTurns: number;
	title: string;
	turns: string[][];
}

export const SIMULATION_SCENARIOS: SimulationScenario[] = [
	{
		id: "1",
		leadName: "Davi",
		offerWithinTurns: 7,
		title: "Transcript de produção (lead 3cc1444c-…)",
		turns: [
			["Ola Mariana boa noite meu nome é Davi", "eu quero fazer um consorcio"],
			["eu quero comprar um carro novo"],
			[
				"eu ja tenho um veiculo mas ele é usado",
				"mas agora eu quero um novinho",
			],
			["necessidade"],
			["sim gostaria"],
			["eu ja disse isso", "veiculo"],
			["eu quero comprar um carro novo", "eu posso falar com o consultor?"],
		],
	},
	{
		id: "2",
		offerWithinTurns: 4,
		title: "Caminho feliz: oi → nome → motivo → oferta → sim",
		turns: [["oi"], ["Davi"], ["quero um carro novo"], ["sim"]],
	},
	{
		id: "3",
		leadName: "Davi",
		offerWithinTurns: 2,
		title: "Pedido explícito de consultor logo no início",
		turns: [
			["oi, quero falar com um consultor"],
			["quero comprar um apartamento"],
		],
	},
	{
		id: "8",
		leadName: "Davi",
		offerWithinTurns: 3,
		title: "Pergunta sensível → handoff + oferta na mesma mensagem",
		turns: [
			["oi, quero comprar um carro"],
			["quanto fica a parcela?"],
			["sim"],
		],
	},
];

export interface ScenarioResult {
	failures: string[];
	scenario: SimulationScenario;
	turns: SimulatedTurn[];
}

const BLOCKED = (name: string) => async () => {
	throw new Error(`${name} is blocked in the conversation simulator`);
};

// WhatsApp becomes a no-op stub; Google Calendar throws if anything reaches it.
export function stubExternalServicesForSimulation() {
	const noopSend = async () => ({
		contacts: [],
		messages: [{ id: `wamid.simulator_${Date.now()}` }],
		messaging_product: "whatsapp",
	});
	for (const method of Object.getOwnPropertyNames(WhatsAppService.prototype)) {
		if (method.startsWith("send")) {
			Object.assign(WhatsAppService.prototype, { [method]: noopSend });
		}
	}
	Object.assign(GoogleCalendarService.prototype, {
		createEvent: BLOCKED("GoogleCalendarService.createEvent"),
		deleteEvent: BLOCKED("GoogleCalendarService.deleteEvent"),
		getBusyPeriods: BLOCKED("GoogleCalendarService.getBusyPeriods"),
	});
}

export async function runScenario(
	scenario: SimulationScenario
): Promise<ScenarioResult> {
	const fixture = await createConversationFixture({ name: scenario.leadName });
	const schedulingAvailabilityService = buildFakeAvailabilityService({
		count: 0,
	});
	const turns: SimulatedTurn[] = [];

	try {
		for (const user of scenario.turns) {
			const result = await generateMarianaResponse({
				currentMessages: user,
				leadId: fixture.leadId,
				schedulingAvailabilityService,
			});
			const lead = await loadLead(fixture.leadId);

			turns.push({
				known: {
					currentSituation: Boolean(lead.currentSituation?.trim()),
					interestedInConsultant: lead.interestedInConsultant === true,
					name: isNameKnown(lead.name, lead.phone),
					objective: Boolean(lead.objective?.trim()),
					painPoint: Boolean(lead.painPoint?.trim()),
				},
				offered: Boolean(result.schedulingOffer),
				reply: result.result.reply,
				user,
			});

			if (result.schedulingOffer) {
				break;
			}
		}
	} finally {
		await cleanupConversationFixture(fixture.leadId);
	}

	return {
		failures: evaluateSimulatedConversation({
			offerWithinTurns: scenario.offerWithinTurns,
			turns,
		}),
		scenario,
		turns,
	};
}

export function formatSimulationReport(
	results: ScenarioResult[],
	generatedAt: Date
): string {
	const lines = [
		"# Conversation simulator report",
		"",
		`Generated: ${generatedAt.toISOString()}. Real Gemini, local test database, WhatsApp stubbed, Calendar mocked.`,
		"",
	];

	for (const { failures, scenario, turns } of results) {
		lines.push(
			`## Scenario ${scenario.id} — ${scenario.title}: ${failures.length === 0 ? "PASS" : "FAIL"}`,
			"",
			`Offer flow required within ${scenario.offerWithinTurns} turns.`,
			""
		);
		for (const [index, turn] of turns.entries()) {
			lines.push(
				`**${index + 1}. Cliente:** ${turn.user.join(" / ")}`,
				"",
				`**Mariana:** ${turn.offered ? "[horários] " : ""}${turn.reply.replace(/\n+/g, " ")}`,
				""
			);
		}
		if (failures.length > 0) {
			lines.push(
				"Failures:",
				"",
				...failures.map((failure) => `- ${failure}`),
				""
			);
		}
	}

	return `${lines.join("\n").trimEnd()}\n`;
}
