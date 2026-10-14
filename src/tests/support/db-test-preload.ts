// Carregado via `tsx --import` antes de qualquer arquivo de teste. Troca o
// `DATABASE_URL` pelo `TEST_DATABASE_URL` antes de `src/env.ts` ser lido, e
// aborta se o banco de teste não for seguro.
import "dotenv/config";

import {
	describeDatabaseHost,
	resolveTestDatabaseEnv,
} from "./test-database-guard";

const overrides = resolveTestDatabaseEnv(process.env);
Object.assign(process.env, overrides);

if (!process.env.DB_TEST_PRELOAD_LOGGED) {
	process.env.DB_TEST_PRELOAD_LOGGED = "1";
	console.error(
		`[db-test-guard] using test database ${describeDatabaseHost(overrides.DATABASE_URL)}`
	);
}
