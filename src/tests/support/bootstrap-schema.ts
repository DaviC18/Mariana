/** biome-ignore-all lint/performance/noBarrelFile: <> */
// Entrada de schema usada só pelo bootstrap do banco de teste
// (`drizzle-kit push`). O barrel `src/db/schema/index.ts` não exporta o enum
// `scheduling_session_workflow_stage`, então o push sem ele falha ao criar
// `scheduling_sessions`. Provisório até a consolidação das migrations.
export * from "../../db/schema";
export { schedulingSessionWorkflowStage } from "../../db/schema/scheduling-sessions";
