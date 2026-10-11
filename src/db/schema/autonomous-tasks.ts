import {
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";

import { conversations } from "./conversations";
import { messages } from "./messages";

export const autonomousTaskStatus = pgEnum("autonomous_task_status", [
	"pending",
	"processing",
	"completed",
	"failed",
]);

export const autonomousTasks = pgTable(
	"autonomous_tasks",
	{
		// Controle de tentativas e recuperação.
		attempts: integer().notNull().default(0),

		availableAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		completedAt: timestamp({ withTimezone: true }),

		conversationId: uuid()
			.notNull()
			.references(() => conversations.id, {
				onDelete: "cascade",
			}),

		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		id: uuid().primaryKey().defaultRandom(),

		// Impede a criação duplicada da mesma tarefa.
		idempotencyKey: text().notNull().unique(),
		lastError: text(),

		lockedAt: timestamp({ withTimezone: true }),
		maxAttempts: integer().notNull().default(5),
		maxSteps: integer().notNull().default(8),

		// Guarda os dados necessários para executar a tarefa.
		// Não duplicar aqui o texto completo das mensagens.
		payload: jsonb().$type<Record<string, unknown>>().notNull().default({}),

		// Resultado persistido da execução, quando existir.
		result: jsonb().$type<Record<string, unknown>>(),
		startedAt: timestamp({ withTimezone: true }),

		status: autonomousTaskStatus().notNull().default("pending"),

		// Ajuda a limitar a quantidade de etapas do fluxo.
		stepNumber: integer().notNull().default(0),

		// Ex.: process_inbound, execute_action, send_message.
		taskType: text().notNull(),

		// Mensagem que iniciou o fluxo autônomo.
		triggerMessageId: uuid()
			.notNull()
			.references(() => messages.id, {
				onDelete: "cascade",
			}),

		updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),

		// Identifica toda a sequência de tarefas de um atendimento.
		workflowId: uuid().notNull().defaultRandom(),
	},
	(table) => ({
		conversationCreatedAtIdx: index(
			"autonomous_tasks_conversation_created_at_idx"
		).on(table.conversationId, table.createdAt),
		statusAvailableAtIdx: index("autonomous_tasks_status_available_at_idx").on(
			table.status,
			table.availableAt
		),

		workflowStepIdx: index("autonomous_tasks_workflow_step_idx").on(
			table.workflowId,
			table.stepNumber
		),
	})
);
