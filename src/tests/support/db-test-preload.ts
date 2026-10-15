// Carregado via `tsx --import` antes de qualquer arquivo de teste. Troca o
// `DATABASE_URL` pelo `TEST_DATABASE_URL` antes de `src/env.ts` ser lido, e
// aborta se o banco de teste não for seguro. Também troca as credenciais
// externas por valores falsos.
import "dotenv/config";

import { FAKE_EXTERNAL_ENV } from "./fake-external-env";
import {
	describeDatabaseHost,
	resolveTestDatabaseEnv,
} from "./test-database-guard";

const overrides = resolveTestDatabaseEnv(process.env);
Object.assign(process.env, FAKE_EXTERNAL_ENV, overrides);

if (!process.env.DB_TEST_PRELOAD_LOGGED) {
	process.env.DB_TEST_PRELOAD_LOGGED = "1";
	console.error(
		`[db-test-guard] using test database ${describeDatabaseHost(overrides.DATABASE_URL)}`
	);
}
