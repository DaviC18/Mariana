import assert from "node:assert/strict";
import test from "node:test";

import {
	describeDatabaseHost,
	resolveTestDatabaseEnv,
	UnsafeTestDatabaseError,
} from "./support/test-database-guard";

const devUrl =
	"postgresql://user:secret@ep-dev-123.sa-east-1.aws.neon.tech/neondb";

test("recusa quando TEST_DATABASE_URL não está definido", () => {
	assert.throws(
		() => resolveTestDatabaseEnv({ DATABASE_URL: devUrl }),
		UnsafeTestDatabaseError
	);
});

test("recusa quando TEST_DATABASE_URL aponta para o mesmo banco que DATABASE_URL", () => {
	assert.throws(
		() =>
			resolveTestDatabaseEnv({
				DATABASE_URL: devUrl,
				TEST_DATABASE_URL:
					"postgresql://other:pw@EP-DEV-123.sa-east-1.aws.neon.tech:5432/neondb?sslmode=require",
			}),
		UnsafeTestDatabaseError
	);
});

test("recusa URL que não é postgres", () => {
	assert.throws(
		() =>
			resolveTestDatabaseEnv({
				DATABASE_URL: devUrl,
				TEST_DATABASE_URL: "mysql://localhost/test",
			}),
		UnsafeTestDatabaseError
	);
});

test("recusa workers de confiabilidade habilitados", () => {
	assert.throws(
		() =>
			resolveTestDatabaseEnv({
				DATABASE_URL: devUrl,
				RELIABILITY_WORKERS_ENABLED: "true",
				TEST_DATABASE_URL:
					"postgresql://postgres:pw@localhost:5433/mariana_test",
			}),
		UnsafeTestDatabaseError
	);
});

test("aceita outro banco no mesmo host e desliga os workers", () => {
	const testUrl =
		"postgresql://user:secret@ep-dev-123.sa-east-1.aws.neon.tech/mariana_test";
	assert.deepEqual(
		resolveTestDatabaseEnv({
			DATABASE_URL: devUrl,
			TEST_DATABASE_URL: testUrl,
		}),
		{
			DATABASE_URL: testUrl,
			NODE_ENV: "test",
			RELIABILITY_WORKERS_ENABLED: "false",
		}
	);
});

test("describeDatabaseHost não expõe a senha", () => {
	const description = describeDatabaseHost(devUrl);
	assert.equal(description, "ep-dev-123.sa-east-1.aws.neon.tech:5432/neondb");
	assert.ok(!description.includes("secret"));
});
