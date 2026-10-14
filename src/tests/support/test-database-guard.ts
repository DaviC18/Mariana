/**
 * Proteção para testes que escrevem no banco. Exige um `TEST_DATABASE_URL`
 * descartável, diferente do `DATABASE_URL` de desenvolvimento, e devolve as
 * variáveis que o processo de teste deve usar.
 */
const LEADING_SLASH = /^\//;

export class UnsafeTestDatabaseError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "UnsafeTestDatabaseError";
	}
}

function parsePostgresUrl(name: string, value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch (error) {
		throw new UnsafeTestDatabaseError(`${name} is not a valid URL`, {
			cause: error,
		});
	}
	if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
		throw new UnsafeTestDatabaseError(`${name} must be a postgresql:// URL`);
	}
	return url;
}

function databaseIdentity(url: URL): string {
	const port = url.port || "5432";
	const database = url.pathname.replace(LEADING_SLASH, "") || "postgres";
	return `${url.hostname.toLowerCase()}:${port}/${database}`;
}

export function describeDatabaseHost(value: string): string {
	return databaseIdentity(parsePostgresUrl("database URL", value));
}

export function resolveTestDatabaseEnv(source: NodeJS.ProcessEnv): {
	DATABASE_URL: string;
	NODE_ENV: "test";
	RELIABILITY_WORKERS_ENABLED: "false";
} {
	const testUrl = source.TEST_DATABASE_URL;
	if (!testUrl) {
		throw new UnsafeTestDatabaseError(
			"TEST_DATABASE_URL is required for DB tests. Point it at a disposable database (Neon branch or local Postgres)."
		);
	}

	const testIdentity = databaseIdentity(
		parsePostgresUrl("TEST_DATABASE_URL", testUrl)
	);

	const devUrl = source.DATABASE_URL;
	if (devUrl) {
		const devIdentity = databaseIdentity(
			parsePostgresUrl("DATABASE_URL", devUrl)
		);
		if (devIdentity === testIdentity) {
			throw new UnsafeTestDatabaseError(
				`TEST_DATABASE_URL points at the same database as DATABASE_URL (${testIdentity}). Refusing to run DB tests.`
			);
		}
	}

	if (source.RELIABILITY_WORKERS_ENABLED === "true") {
		throw new UnsafeTestDatabaseError(
			"RELIABILITY_WORKERS_ENABLED=true is not allowed in test runs."
		);
	}

	return {
		DATABASE_URL: testUrl,
		NODE_ENV: "test",
		RELIABILITY_WORKERS_ENABLED: "false",
	};
}
