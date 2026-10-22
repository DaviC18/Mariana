# CODEMAP — Mariana (read this BEFORE exploring the repo)

Snapshot of `develop` @ e402b13. ~12.8k lines in `src/` (excluding tests), 55 test files.
**Keep it current:** whoever adds, moves or deletes a file under `src/` updates its line here in the same change.

## Request pipeline (WhatsApp text message)
```
routes/whatsapp/webhook-whatsapp.ts       HMAC check → dedup (whatsapp_webhook_events) → lead/conversation → persist inbound → enqueueTask(process_inbound_message, debounce cutoff)
services/reliability/background-workers.ts → autonomous-task-executor.ts (claim with lease, one task per conversation)
services/conversations/autonomous-task-handlers.ts  handleProcessInboundMessage → batch (inbound-message-batch.ts) → generateMarianaResponse → enqueueOutboundMessage
services/conversations/generateMarianaResponse.ts   lead + history → conversation-stage.ts (stage/question) → ai/agent.ts (Gemini) → update-lead-from-agent → execute-next-action → persistAuthorizedAssistantReply → scheduling offer
services/messaging/outbound-messages.ts   outbox claim/lease → whatsapp-compliance → integrations/whatsapp/whatsapp-client.ts → sent/unknown/failed
```
Button replies: `webhook-whatsapp.ts` → task `process_button_reply` / `process_consultant_preference_reply` / `process_consultant_selection` / `send_confirmation_request` → handlers in `autonomous-task-handlers.ts` → `services/calendar/*` → outbox.

## Where things live
| Need | File(s) |
|---|---|
| System prompt (pt-BR rules) | `src/ai/prompt.ts` (389 lines) |
| Gemini call, model name, stage guidance, reply post-processing | `src/ai/agent.ts` (`MODEL`, `STAGE_GUIDANCE`, `generateMarianaReply`) |
| Gemini client / retries | `src/ai/client.ts` |
| Structured response schema | `src/ai/schemas/mariana-response-schema.ts` |
| Knowledge base + retrieval | `src/ai/knowledge/{consorcio,products,ademicon,index}.ts`, `retrieve.ts` |
| Sensitive topics / access levels / `CONSULTANT_OFFER_TEXT` / `COMMERCIAL_HANDOFF` | `src/ai/knowledge/commercial-policy.ts` |
| Evidence validation (replaces the reply with handoff) | `src/ai/knowledge/validate-response.ts` |
| Identity / guardrail sanitizers | `src/services/conversations/mariana-safety.ts` |
| Conversation stage machine, asked-questions, `composeStageReply` | `src/services/conversations/conversation-stage.ts` |
| Main turn orchestration (largest logic file) | `src/services/conversations/generateMarianaResponse.ts` (707) |
| Pending yes/no offer detection | `src/services/conversations/pending-offer.ts` |
| Action gate (`offer_meeting`, intent regexes) | `src/services/agent/execute-next-action.ts` |
| Qualification rules / missing fields / fallback questions | `src/services/leads/lead-qualification.ts`, `qualification-gaps.ts` |
| Lead updates from the model, status transitions | `src/services/leads/update-lead-from-agent.ts`, `lead-status.ts` |
| Lead ingestion (WhatsApp / Meta Ads / Google Ads) | `src/services/leads/lead-ingestion.ts`, `routes/meta-ads/*`, `routes/google-ads/*` |
| All task handlers (inbound + every button step) | `src/services/conversations/autonomous-task-handlers.ts` (1016) |
| Task queue, lease, retry | `src/services/conversations/autonomous-task-executor.ts`, `autonomous-task-row.ts`, `src/db/raw-row.ts` |
| Debounce / batching | `inbound-message-batch.ts` (durable), `message-debounce.ts` (in-memory, legacy route) |
| Scheduling: availability | `services/calendar/{availability,consultant-availability,scheduling-availability}.ts` |
| Scheduling: offer, buttons, session | `services/calendar/scheduling-offer-service.ts`, `scheduling-session-expiration.ts` |
| Scheduling: slot choice / confirm / cancel | `services/calendar/scheduling-{choice,confirmation,cancellation}-service.ts`, `scheduling-confirmation-orchestrator.ts` |
| Appointment creation (Calendar + DB + compensation) | `services/calendar/appointment-service.ts` |
| Consultant load balancing | `services/consultants/consultant-load.ts` |
| Google Calendar API + OAuth route | `integrations/google-calendar/*`, `routes/google-calendar/auth-google.ts` |
| WhatsApp send, error classification, timeout | `integrations/whatsapp/{whatsapp-client,whatsapp-errors,whatsapp-service}.ts` |
| 24h window / opt-out | `services/conversations/whatsapp-compliance.ts` |
| Env vars | `src/env.ts` |
| Logger redaction | `src/lib/logger.ts` |
| DB schema (Drizzle) | `src/db/schema/*.ts` (one file per table); `relations.ts` |
| Migrations (FROZEN) | `drizzle/` |

## Tables → schema file
leads, conversations, messages, consultants, appointments, google_calendar_connections, scheduling_sessions (`workflowStage`), scheduling_slots, whatsapp_webhook_events, outbound_messages, autonomous_tasks → `src/db/schema/<kebab-name>.ts`.

## Tests
- Unit list (no DB): the explicit file list in `package.json` → `test:unit`. A new unit test file must be added there.
- DB tests: everything else under `src/tests/**` (`test:db`, local `TEST_DATABASE_URL`).
- Support: `src/tests/support/` (guards, preloads, `setup-test-db.ts`, seed).
- Folders: `src/tests/{services,reliability,routes,integrations,google-calendar}`.
- Simulator: `scripts/simulate-conversation.ts` (`npm run sim:conversation`, real Gemini — owner permission only).

## Docs
`CLAUDE.md` (rules), `docs/specs/` (specs + `MARIANA_BEHAVIOR_SPEC.md`), `docs/work/<task>/` (plans, progress, reports), `docs/NEON_SNAPSHOT_*.md` (production evidence), `docs/AGENT_TEAM.md` (team workflow).
