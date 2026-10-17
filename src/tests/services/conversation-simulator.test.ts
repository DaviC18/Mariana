/** biome-ignore-all lint/performance/useTopLevelRegex: <> */
// Plumbing test for the opt-in simulator with a canned Gemini client: the
// real run (`npm run sim:conversation -- --real-gemini`) uses the same code.
import assert from "node:assert/strict";
import test from "node:test";

import { ai } from "../../ai/client";
import { closeDatabase } from "../../db/connections";
import {
	formatSimulationReport,
	runScenario,
	SIMULATION_SCENARIOS,
	stubExternalServicesForSimulation,
} from "../support/conversation-simulator";

test.after(async () => {
	await closeDatabase();
});

test("simulador roda o caminho feliz e gera relatório", async () => {
	const original = ai.models.generateContent;
	Object.assign(ai.models, {
		generateContent: async () => ({
			text: JSON.stringify({
				leadUpdate: { status: "qualifying" },
				nextAction: "continue_qualification",
				reply: "Entendi.",
			}),
		}),
	});
	stubExternalServicesForSimulation();

	try {
		const scenario = SIMULATION_SCENARIOS.find((item) => item.id === "2");
		assert.ok(scenario);
		const result = await runScenario(scenario);

		assert.deepEqual(result.failures, []);
		assert.equal(result.turns.at(-1)?.offered, true);

		const report = formatSimulationReport([result], new Date(0));
		assert.match(report, /## Scenario 2 .*: PASS/);
		assert.match(report, /\*\*1\. Cliente:\*\* oi/);
	} finally {
		Object.assign(ai.models, { generateContent: original });
	}
});
