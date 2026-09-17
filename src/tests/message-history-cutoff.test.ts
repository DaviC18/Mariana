import assert from "node:assert/strict";
import test from "node:test";

import { PgDialect } from "drizzle-orm/pg-core";

import { buildMessageHistoryCondition } from "../services/conversations/generateMarianaResponse";

const dialect = new PgDialect();
const conversationColumn = /messages"\."conversationId/;
const createdAtColumn = /messages"\."createdAt/;
const idColumn = /messages"\."id/;

test("histórico inclui os IDs do bloco sem remover o cutoff", () => {
	const query = dialect.sqlToQuery(
		buildMessageHistoryCondition({
			conversationId: "conversation-1",
			messageCutoff: new Date("2026-09-16T22:52:51.664Z"),
			messageIds: ["message-1", "message-2"],
		})
	);

	assert.match(query.sql, conversationColumn);
	assert.match(query.sql, createdAtColumn);
	assert.match(query.sql, idColumn);
	assert.equal(query.params.length, 4);
});

test("sem IDs do bloco o histórico continua usando somente o cutoff", () => {
	const query = dialect.sqlToQuery(
		buildMessageHistoryCondition({
			conversationId: "conversation-1",
			messageCutoff: new Date("2026-09-16T22:52:51.664Z"),
		})
	);

	assert.doesNotMatch(query.sql, idColumn);
	assert.equal(query.params.length, 2);
});
