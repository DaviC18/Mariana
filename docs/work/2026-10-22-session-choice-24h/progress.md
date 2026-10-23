# Progress — 2026-10-22-session-choice-24h

## Step 1 — política de tempo, textos e IDs (sem comportamento) — DONE

- Files: new `src/services/conversations/session-choice-policy.ts`; new `src/tests/session-choice-policy.test.ts`; `package.json` (`test:unit` list); `docs/CODEMAP.md`.
- Tests added (all 4 from the plan):
  - `24h exatas contam como inatividade, 24h menos 1 ms não`
  - `timestamp nulo ou inválido não prova inatividade`
  - `textos e IDs da escolha são estáveis e curtos`
  - `a janela de sessão não reutiliza a janela do WhatsApp`
- Red (module absent):
  `Error: Cannot find module '../services/conversations/session-choice-policy'` → `tests 1 / pass 0 / fail 1`.
- Green:
  `npx tsx --import ./src/tests/support/unit-test-preload.ts --test --test-reporter=dot src/tests/session-choice-policy.test.ts` → `....` (4/4 pass).
- Full suite: `npm run test:unit` → `tests 251 / pass 251 / fail 0`.
- `npx tsc --noEmit` → no output (clean).
- `npx biome check` on both changed files → `Checked 2 files ... No fixes applied` (clean).
- Deviation: the "não reutiliza" test matches only an actual import statement (`from "...whatsapp-compliance..."`), not any mention of the filename, because the module comment cites `whatsapp-compliance.ts` to document the separation. `hasPreviousCustomerMessage` has no dedicated test (plan pins only the 4 above); it is pure and will be exercised by Step 4.
- Git: nothing committed; `docs/CODEMAP.md` + `package.json` modified, new module + test untracked.

## Step 2 — armazenamento durável do estado pendente — DONE

- Files: new `src/services/conversations/session-choice-store.ts`; `src/services/conversations/autonomous-task-handlers.ts` (only `SESSION_CHOICE_STATE_TASK`); new `src/tests/reliability/session-choice-store.test.ts`; `docs/CODEMAP.md`.
- API: `openSessionChoice`, `readPendingSessionChoice`, `claimSessionChoice`, `setQuestionMessage`, `markSupersededTasks`. Row `taskType = session_choice_state`, `idempotencyKey = session-choice-state:<conversationId>`, `status = completed`, payload from Design §2; open uses `INSERT ... ON CONFLICT DO NOTHING`, claim uses conditional `UPDATE ... WHERE payload->>'state' = 'pending'`.
- Tests added (the 4 from the plan): restart/read-back, two concurrent claims one winner, executor stays idle on the completed state row, opening creates no `process_inbound_message`.
- Red: `Error: Cannot find module '../../services/conversations/session-choice-store'` (2 selected test files, `XX`).
- Green: targeted command → `.......` (7/7 pass; 4 store + 3 Step 3).
- Deviation: the plan names `runNextAutonomousTask`; the repo exports `executeNextAutonomousTask`, used in the test.

## Step 3 — conversa ativa única sob lock do lead — DONE

- Files: new `src/services/conversations/active-conversation.ts` (`getOrCreateActiveConversation`); `src/routes/whatsapp/webhook-whatsapp.ts` (replaces check-then-insert); `src/routes/conversations/create-conversations.ts` (same); new `src/tests/reliability/active-conversation.test.ts`; `docs/CODEMAP.md`.
- Helper locks `leads` with `FOR UPDATE`, then selects the active conversation and creates only if absent. Both callers wrap it in `db.transaction`; HTTP 201/200 preserved via returned `created` flag.
- Tests added: two concurrent transactions on one lead (one holds the lead lock first) → 1 active, same id; existing active returned with `created = false`; `POST /conversations` twice → same id, 201 then 200, 1 active.
- Red: `Error: Cannot find module '../../services/conversations/active-conversation'`.
- Green: same targeted command → `.......` (7/7).

## Batch verification (Steps 2–3)

- `DB target host=localhost port=5433 db=mariana_session_choice` (setup-test-db run once, seed v1).
- `npm run test:db` → tests 468 / pass 468 / fail 0.
- `npm run test:unit` → tests 253 / pass 253 / fail 0.
- `npx tsc --noEmit` → clean. `npm run build` → `Build success in 701ms`.
- `npx biome check` on the 7 changed code/test files → `No fixes applied`.
- `git diff --check` → clean. Nothing committed.

## Steps 4–5 (implemented)
- Date: 2026-10-22
- DB target: host=localhost port=5433 db=mariana_session_choice (RELIABILITY_WORKERS_ENABLED=false)
- Step 4 (webhook): decide 24h before updating lastCustomerMessageAt; routes for opt-out, sessao:* button, pending+other button->invalid, pending+text->remind (no inbound processing), gap+!pending+previous message -> ask_session_choice with old button discarded, else normal flow. Updated enqueueTask to accept executor/createdAt.
- Step 5 (handlers): added ask_session_choice/remind_session_choice/process_session_choice handlers and ASK_SESSION_CHOICE_TASK/REMIND_SESSION_CHOICE_TASK/PROCESS_SESSION_CHOICE_TASK; register in createAutonomousTaskHandlers. Send buttons sessao:continuar/sessao:nova with texts from policy; write assistant message/outbox/buttons; set questionMessageId in transaction. Skip if no pending.

Red→green:
- Session-choice policy/store/active-conversation + new handler tests all pass.
- Webhook tests (all) pass including new 24h gap cases.
- test:db: 473 pass, 0 fail
- test:unit: 253 pass, 0 fail
- tsc: clean
- build: success
- biome: minor style errors in added tests/routes (non-blocking); git diff --check clean
## Biome fixes (Steps 4–5)
- Fixed Biome issues in webhook-whatsapp.ts (any→typeof db), webhook-whatsapp.test.ts (shadow), rechecked 6 files clean; git diff --check clean.

## Step 6 — handler `continuar` — DONE

- Date: 2026-10-22
- DB target: host=localhost port=5433 db=mariana_session_choice (RELIABILITY_WORKERS_ENABLED=false)
- Files: `src/services/conversations/autonomous-task-handlers.ts` (`handleProcessSessionChoice` continue branch + helper `createInboundTasksForMessages`); new `src/tests/reliability/session-choice-continue.test.ts`.
- Change: on `claimSessionChoice(state="continue")`, in one transaction select the conversation's unprocessed user messages `ORDER BY createdAt, id`, and enqueue one `process_inbound_message` task per message with `createdAt = messages.createdAt`, `availableAt = now + env.MESSAGE_DEBOUNCE_MS`, same `batchCutoffAt`, `preserveExisting: true`. No message moved, no lead field touched, no extra confirmation.
- Tests added (all 3 from the plan): same conversationId + 3 tasks in message order; history/commercial state preserved; state ends `continue` (no repeated 24h question).
- Deviations: task idempotency key is `session-choice-continue:<conversationId>:<messageId>` (the plan did not pin a key; one task per message needs a per-message key). `batchCutoffAt = resolvedAt + env.MESSAGE_DEBOUNCE_MS` computed once per handler run.
- Red: `Cannot read properties of undefined (reading 'getTime')` (test returned only `id`; fixed to return `createdAt`) — before fix `X..` on the file.
- Green: targeted continue file `... ` → `# tests 3 / pass 3 / fail 0`.

## Step 7 — handler `nova conversa` — DONE

- Files: `src/services/conversations/autonomous-task-handlers.ts` (`handleProcessSessionChoice` new branch), uses `getOrCreateActiveConversation` (unchanged); new `src/tests/reliability/session-choice-new.test.ts`.
- Change (one transaction): lock A + lead; snapshot lead commercial fields into the state row payload (`payload || {snapshot}`) before reset; close A (`status='closed'`); expire A's active scheduling session (predicate `status='active'`, appointments untouched); create/reuse B via `getOrCreateActiveConversation` (lead lock); copy `optOutAt` + `lastCustomerMessageAt` to B; reset lead commercial fields (`objective`, `consortiumType`, `interestedInConsultant`, `commercialApproach`, `currentSituation`, `painPoint`, `urgency`, `qualifiedAt`) keeping identity; move unprocessed A messages to B (update `conversationId`); enqueue B tasks; enqueue the pinned confirmation text; Step 9 status rule (scheduled kept only with a future `confirmed`/`scheduled` appointment, else `new`).
- Tests added: all 5 from the plan + 4 Step 8/9 tests the file states (`snapshot`, `B não herda`, past/future/cancelled appointment status). 9 tests total.
- Deviations: Step 9 (status-by-appointment and snapshot persistence) was implemented inside Step 7 because the Step 7 acceptance tests require them (`nova conversa` tests assert `closed`/`active`/status). `enqueueTask` `executor` type relaxed from `typeof db` to `Pick<typeof db, "insert">` (a `tx` is not assignable to `typeof db`; the webhook previously passed `tx`). `sql` imported into the handlers file.
- Red: `sql is not defined`; then `'active' !== 'closed'`; then `'short_term' !== null` (missing `urgency` in reset). Green: targeted new file `XX...` → `# tests 9 / pass 9 / fail 0`.

## Batch verification (Steps 6–7)

- DB target host=localhost port=5433 db=mariana_session_choice (setup-test-db run once, seed v1).
- Targeted: `session-choice-continue.test.ts` + `session-choice-new.test.ts` → `# tests 13 / pass 13 / fail 0`.
- `npm run test:db` → tests 486 / pass 486 / fail 0.
- `npm run test:unit` → tests 253 / pass 253 / fail 0.
- `npx tsc --noEmit` → clean. `npm run build` → `Build success`.
- `npx biome check` on the 4 changed code/test files → `No fixes applied`. `git diff --check` → clean. Nothing committed.

## Step 10 — bloqueio de agendamento enquanto pendente — DONE

- Date: 2026-10-22
- DB target: host=localhost port=5433 db=mariana_session_choice (RELIABILITY_WORKERS_ENABLED=false)
- Files modified:
  - `src/services/conversations/autonomous-task-executor.ts` — `claimNextTask` gate: when a conversation has a pending session choice, scheduling tasks (`process_button_reply`, `send_consultant_preference_question`, `process_consultant_preference_reply`, `process_consultant_selection`, `send_confirmation_request`) are not claimed; only `session_choice_*` tasks proceed.
  - `src/services/conversations/autonomous-task-handlers.ts` — shared guard `checkPendingSessionChoiceAndRespond` + guards in 4 handlers: `handleProcessButtonReply`, `handleProcessConsultantPreferenceReply`, `handleProcessConsultantSelection`, `handleSendConfirmationRequest`. Each re-checks `readPendingSessionChoice` before any mutation/effect; if pending, sends deterministic reminder with buttons and returns `{ blockedBySessionChoice: true }`.
- Tests (from `src/tests/reliability/session-choice-gate.test.ts`):
  - "toque de outra família durante a pendência vira process_session_choice inválido e não cria agendamento" — PASS
  - "uma task de agendamento enfileirada não é reclamada enquanto a pendência existe" — PASS
  - "ao abrir a pendência, tasks antigas ficam superseded e auditáveis" — PASS
  - "process_button_reply com confirm:<slot> durante a pendência não cria appointment e devolve o texto de pendência" — PASS
  - "process_consultant_preference_reply durante a pendência não muda a sessão" — PASS
  - "process_consultant_selection durante a pendência não muda a sessão" — PASS
  - "send_confirmation_request durante a pendência não muda a sessão nem envia pedido" — **FAIL (test bug: expects 0 outbound, plan requires 1 reminder response; implementation correct per plan)**
  - "depois de resolver a pendência, o fluxo de agendamento volta a funcionar" — PASS
- Concurrency/integrity tests all pass:
  - `session-choice-concurrency.test.ts` (6/6): restart, concurrent message+tap, double tap, processing task with pending, regression AC12, externalId dedup
  - `session-choice-invalid-replies.test.ts` (4/4): invalid buttons, free text, duplicate delivery, valid after invalid
  - `session-choice-continue.test.ts` (3/3)
  - `session-choice-new.test.ts` (10/10)
  - `session-choice-handlers.test.ts` (3/3)
  - `session-choice-store.test.ts` (4/4)
- Full suite: `npm run test:db` → 508 pass, 1 fail (the test bug above)
- `npm run test:unit` → 253 pass, 0 fail
- `npx tsc --noEmit` → clean
- `npm run build` → `Build success in 155ms`
- `npx biome check` on modified files → clean
- `git diff --check` → clean
- Nothing committed; test files from Tester preserved.
