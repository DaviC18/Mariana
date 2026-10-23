// Config do drizzle-kit usada só pelo bootstrap do banco de teste
// (`setup-test-db.ts`). Lê o `TEST_DATABASE_URL` já validado pelo guard, para
// a URL (com senha) não ir na linha de comando.
import "dotenv/config";

import { defineConfig } from "drizzle-kit";

import { resolveTestDatabaseEnv } from "./test-database-guard";

export default defineConfig({
	dbCredentials: { url: resolveTestDatabaseEnv(process.env).DATABASE_URL },
	dialect: "postgresql",
	schema: "./src/tests/support/bootstrap-schema.ts",
});
