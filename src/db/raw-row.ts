import { getTableColumns, type InferSelectModel } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

/**
 * Linhas de `db.execute(sql\`... RETURNING *\`)` não passam pelos mappers de
 * coluna do drizzle. Com o driver postgres-js, `timestamptz` chega como string
 * (ex.: "2026-10-14 22:13:01.939123+00") e jsonb pode chegar como texto.
 * `mapRawRow` restaura os tipos declarados no schema da tabela; use-o em toda
 * query crua que devolve linhas inteiras.
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

function toJson(value: unknown): unknown {
	return typeof value === "string" ? JSON.parse(value) : value;
}

export function mapRawRow<TTable extends PgTable>(
	table: TTable,
	row: Record<string, unknown>
): InferSelectModel<TTable> {
	const mapped: Record<string, unknown> = {};
	for (const [key, column] of Object.entries(getTableColumns(table))) {
		const value = row[column.name];
		if (value === undefined && column.notNull) {
			// Coluna obrigatória ausente: schema divergente ou RETURNING
			// parcial. Falha aqui em vez de propagar `null` tipado como valor.
			throw new TypeError(
				`Raw row is missing NOT NULL column "${column.name}"`
			);
		}
		if (value === null || value === undefined) {
			mapped[key] = null;
		} else if (column.dataType === "object date") {
			mapped[key] = toDate(value);
		} else if (column.dataType === "object json") {
			mapped[key] = toJson(value);
		} else {
			mapped[key] = value;
		}
	}
	return mapped as InferSelectModel<TTable>;
}
