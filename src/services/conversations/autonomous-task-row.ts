import type { InferSelectModel } from "drizzle-orm";

import { mapRawRow } from "../../db/raw-row";
import { autonomousTasks } from "../../db/schema";

export type AutonomousTask = InferSelectModel<typeof autonomousTasks>;

/** Linha crua do claim (`RETURNING task.*`) com os tipos do schema. */
export function mapAutonomousTaskRow(
	row: Record<string, unknown>
): AutonomousTask {
	return mapRawRow(autonomousTasks, row);
}
