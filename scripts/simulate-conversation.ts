/** biome-ignore-all lint/performance/noAwaitInLoops: scenarios run one after another */
// Opt-in conversation simulator: real Gemini, local test database, WhatsApp
// stubbed, Google Calendar mocked. Spends Gemini quota, so it only runs with
// the explicit `--real-gemini` flag.
//
//   TEST_DATABASE_URL=postgresql://mariana:mariana@localhost:5432/mariana_test \
//     npm run sim:conversation -- --real-gemini
//
// The test database must already be prepared (`npm run test:db` resets,
// builds and seeds it). Writes docs/sim-report.md and exits non-zero when any
// scenario fails.
import "dotenv/config";

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { FAKE_EXTERNAL_ENV } from "../src/tests/support/fake-external-env";
import {
	describeDatabaseHost,
	resolveTestDatabaseEnv,
} from "../src/tests/support/test-database-guard";

async function main() {
	if (!process.argv.includes("--real-gemini")) {
		console.error(
			"Refusing to run: this simulator calls the real Gemini API. Re-run with --real-gemini."
		);
		process.exit(2);
	}

	// Throws when TEST_DATABASE_URL is unset, equals DATABASE_URL or is on Neon.
	const databaseEnv = resolveTestDatabaseEnv(process.env);
	const geminiApiKey = process.env.GEMINI_API_KEY;
	if (!geminiApiKey || geminiApiKey === FAKE_EXTERNAL_ENV.GEMINI_API_KEY) {
		console.error("Refusing to run: GEMINI_API_KEY is not set.");
		process.exit(2);
	}

	// Every other external credential is fake: WhatsApp, Meta and Google can
	// never authenticate from this process.
	Object.assign(process.env, FAKE_EXTERNAL_ENV, databaseEnv, {
		GEMINI_API_KEY: geminiApiKey,
	});
	console.error(
		`[sim] using test database ${describeDatabaseHost(databaseEnv.DATABASE_URL)}`
	);

	const simulator = await import("../src/tests/support/conversation-simulator");
	const { closeDatabase } = await import("../src/db/connections");
	simulator.stubExternalServicesForSimulation();

	const results: Awaited<ReturnType<typeof simulator.runScenario>>[] = [];
	try {
		for (const scenario of simulator.SIMULATION_SCENARIOS) {
			console.error(`[sim] scenario ${scenario.id}: ${scenario.title}`);
			const result = await simulator.runScenario(scenario);
			for (const [index, turn] of result.turns.entries()) {
				console.log(`  ${index + 1}. cliente: ${turn.user.join(" / ")}`);
				console.log(
					`     mariana: ${turn.offered ? "[horários] " : ""}${turn.reply.replace(/\n+/g, " ")}`
				);
			}
			console.log(
				result.failures.length === 0
					? "  PASS"
					: `  FAIL\n${result.failures.map((failure) => `   - ${failure}`).join("\n")}`
			);
			results.push(result);
		}
	} finally {
		await closeDatabase();
	}

	// npm runs scripts from the repository root.
	const reportPath = resolve(process.cwd(), "docs/sim-report.md");
	writeFileSync(
		reportPath,
		simulator.formatSimulationReport(results, new Date())
	);
	console.error(`[sim] report written to ${reportPath}`);

	if (results.some((result) => result.failures.length > 0)) {
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
