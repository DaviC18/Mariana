// `npm run test:db`: reset → schema → seed no banco de `TEST_DATABASE_URL`.
//
// Bootstrap provisório: as migrations em `drizzle/` ainda não constroem um
// banco vazio ("Non-commutative migrations detected"), então o schema vem de
// `drizzle-kit push` com `drizzle.test.config.ts` (schema `bootstrap-schema.ts`). Só para teste; trocar por
// `migrate` quando a baseline consolidada existir.
import "dotenv/config";

import { spawnSync } from "node:child_process";
import postgres from "postgres";

import {
	describeDatabaseHost,
	resolveTestDatabaseEnv,
} from "./test-database-guard";
import { seedTestDatabase, TEST_SEED_VERSION } from "./test-seed";

async function main() {
	const { DATABASE_URL: testUrl } = resolveTestDatabaseEnv(process.env);
	console.error(
		`[setup-test-db] target ${describeDatabaseHost(testUrl)} (seed v${TEST_SEED_VERSION})`
	);

	const sql = postgres(testUrl, { max: 1, onnotice: () => undefined });
	try {
		await sql.unsafe(
			"DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"
		);

		const push = spawnSync(
			"npx",
			[
				"drizzle-kit",
				"push",
				"--config",
				"./src/tests/support/drizzle.test.config.ts",
				"--force",
			],
			{ encoding: "utf8", env: process.env }
		);
		if (push.status !== 0) {
			throw new Error(
				`drizzle-kit push failed (exit ${push.status}):\n${push.stderr}\n${push.stdout}`.replaceAll(
					testUrl,
					describeDatabaseHost(testUrl)
				)
			);
		}

		await seedTestDatabase(sql);
		const [{ count }] = await sql<{ count: number }[]>`
			SELECT count(*)::int AS count FROM consultants WHERE active
		`;
		console.error(`[setup-test-db] ready: ${count} active consultants`);
	} finally {
		await sql.end({ timeout: 5 });
	}
}

main().catch((error: unknown) => {
	console.error("[setup-test-db] failed:", error);
	process.exitCode = 1;
});
