import type { InferSelectModel } from "drizzle-orm";

import type { autonomousTasks } from "../../db/schema";

export type AutonomousTask = InferSelectModel<typeof autonomousTasks>;

/**
 * Linhas de `db.execute(sql\`... RETURNING *\`)` não passam pelos mappers de
 * coluna do drizzle. Com o driver postgres-js, `timestamptz` chega como string
 * (ex.: "2026-10-14 22:13:01.939123+00") e jsonb pode chegar como texto. Esta
 * função restaura os tipos declarados no schema.
 */
export function toDate(value: unknown): Date {
	if (value instanceof Date) {
		return value;
	}
	if (typeof value === "string" || typeof value === "number") {
		const date = new Date(value);
		if (Number.isFinite(date.getTime())) {
			return date;
		}
	}
	throw new TypeError(`Invalid timestamp value: ${String(value)}`);
}

function toNullableDate(value: unknown): Date | null {
	return value === null || value === undefined ? null : toDate(value);
}

function toJsonObject(value: unknown): Record<string, unknown> | null {
	if (value === null || value === undefined) {
		return null;
	}
	const parsed = typeof value === "string" ? JSON.parse(value) : value;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new TypeError("Expected a JSON object");
	}
	return parsed as Record<string, unknown>;
}

export function mapAutonomousTaskRow(
	row: Record<string, unknown>
): AutonomousTask {
	const task = row as unknown as AutonomousTask;
	return {
		...task,
		availableAt: toDate(row.availableAt),
		completedAt: toNullableDate(row.completedAt),
		createdAt: toDate(row.createdAt),
		leaseExpiresAt: toNullableDate(row.leaseExpiresAt),
		lockedAt: toNullableDate(row.lockedAt),
		payload: toJsonObject(row.payload) ?? {},
		result: toJsonObject(row.result),
		startedAt: toNullableDate(row.startedAt),
		updatedAt: toDate(row.updatedAt),
	};
}
