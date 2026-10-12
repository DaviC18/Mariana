import { and, eq, lte } from "drizzle-orm";

import type { db as defaultDb } from "../../db/connections";
import { schedulingSessions } from "../../db/schema";

/**
 * Lazily advances an overdue active session to its terminal expired state.
 * The predicate makes this safe if another request closed or expired it first.
 */
export async function expireSchedulingSessionIfOverdue(
	database: typeof defaultDb,
	sessionId: string,
	now: Date
): Promise<boolean> {
	const [expiredSession] = await database
		.update(schedulingSessions)
		.set({
			status: "expired",
			updatedAt: now,
		})
		.where(
			and(
				eq(schedulingSessions.id, sessionId),
				eq(schedulingSessions.status, "active"),
				lte(schedulingSessions.expiresAt, now)
			)
		)
		.returning({ id: schedulingSessions.id });

	return Boolean(expiredSession);
}
