import type { Sql } from "postgres";

/**
 * Seed versionado e idempotente do banco de teste. Os testes de agenda
 * esperam exatamente estes três consultores ativos. Ao mudar a lista,
 * incremente `TEST_SEED_VERSION`.
 */
export const TEST_SEED_VERSION = 1;

export const TEST_CONSULTANTS = [
	{
		calendarId: "joao.silva@seed.test",
		email: "joao.silva@seed.test",
		name: "João Silva",
	},
	{
		calendarId: "maria.souza@seed.test",
		email: "maria.souza@seed.test",
		name: "Maria Souza",
	},
	{
		calendarId: "carlos.oliveira@seed.test",
		email: "carlos.oliveira@seed.test",
		name: "Carlos Oliveira",
	},
] as const;

export async function seedTestDatabase(sql: Sql): Promise<void> {
	const rows = TEST_CONSULTANTS.map((consultant) => ({
		...consultant,
		active: true,
	}));
	await sql`
		INSERT INTO consultants ${sql(rows, "name", "email", "calendarId", "active")}
		ON CONFLICT (email) DO UPDATE
		SET name = EXCLUDED.name,
			"calendarId" = EXCLUDED."calendarId",
			active = true,
			"updatedAt" = now()
	`;
}
