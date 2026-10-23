/** biome-ignore-all lint/style/useFilenamingConvention: <> */
import { and, eq } from "drizzle-orm";

import type { db } from "../../db/connections";
import { conversations, leads } from "../../db/schema";

/**
 * Conexão ou transação. O helper exige uma transação para que o lock do lead
 * valha até o commit da criação da conversa.
 */
export type ActiveConversationExecutor = Pick<typeof db, "insert" | "select">;

export interface GetOrCreateActiveConversationResult {
	conversation: typeof conversations.$inferSelect;
	created: boolean;
}

/**
 * Garante no máximo uma conversa ativa por lead.
 *
 * Sem índice único (migration congelada), a serialização vem do
 * `SELECT ... FOR UPDATE` na linha do lead: duas transações concorrentes
 * esperam a mesma linha e a segunda enxerga a conversa criada pela primeira.
 * Qualquer novo writer de conversa deve usar este helper.
 */
export async function getOrCreateActiveConversation(
	executor: ActiveConversationExecutor,
	leadId: string
): Promise<GetOrCreateActiveConversationResult> {
	const [lead] = await executor
		.select({ id: leads.id })
		.from(leads)
		.where(eq(leads.id, leadId))
		.for("update")
		.limit(1);

	if (!lead) {
		throw new Error(`Lead not found: ${leadId}`);
	}

	const [existing] = await executor
		.select()
		.from(conversations)
		.where(
			and(eq(conversations.leadId, leadId), eq(conversations.status, "active"))
		)
		.limit(1);

	if (existing) {
		return { conversation: existing, created: false };
	}

	const [created] = await executor
		.insert(conversations)
		.values({ leadId })
		.returning();

	if (!created) {
		throw new Error(`Failed to create conversation for lead ${leadId}`);
	}

	return { conversation: created, created: true };
}
