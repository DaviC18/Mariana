# Test report — Steps 4–5 (session choice 24h)

Date: 2026-10-22  
DB target: `postgresql://postgres:postgres@localhost:5433/mariana_session_choice` (RELIABILITY_WORKERS_ENABLED=false; host/port/db printed above). Neon rejected by guard (test DB only). No real services used.

## Plan diff scope
- Approved plan: `docs/work/2026-10-22-session-choice-24h/plan.md` (APPROVED 2026-10-22, Q1–Q8 accepted).  
- Diff scoped to Steps 4–5 (no unapproved changes).  
- Changes: `src/routes/whatsapp/webhook-whatsapp.ts`, `src/services/conversations/autonomous-task-handlers.ts`, `src/services/conversations/session-choice-policy.ts`, `src/services/conversations/session-choice-store.ts`, `src/services/conversations/active-conversation.ts`, `docs/CODEMAP.md`, `package.json` (test list), new tests: `src/tests/session-choice-policy.test.ts`, `src/tests/reliability/session-choice-store.test.ts`, `src/tests/reliability/session-choice-handlers.test.ts`, updates to `src/tests/routes/webhook-whatsapp.test.ts`. `git diff --check`: clean.

## Verification matrix (Steps 4–5)
| Check | Result | Evidence |
|---|---|---|
| Approved plan; diff scoped to Steps 4–5. No unapproved changes. | PASS | Plan approved; only files above changed; `git diff --check` clean. |
| Webhook: reads previous `lastCustomerMessageAt` BEFORE updating it | PASS | `webhook-whatsapp.ts:389-410,499-540` read into `previousLastCustomerMessageAt`, compute gap before updating `conversations.lastCustomerMessageAt` to `receivedAt`. |
| Gap >=24h opens pending, creates `ask_session_choice`, no `process_inbound_message` | PASS | `src/tests/routes/webhook-whatsapp.test.ts: "mensagem com 24h exatas pergunta antes de processar"` → asks, no inbound task; `webhook-whatsapp.ts:442-468,560-586`. |
| Exact 24h boundary; null/invalid => normal | PASS | Policy tests: exact 24h true, 24h-1ms false, null/invalid/future/Invalid Date false. Webhook: null case follows normal flow. |
| Pending + text => remind only, message unprocessed | PASS | `webhook-whatsapp.ts:545-558`; test: "lembrete não cria pergunta duplicada nem processa a mensagem" (handlers) + pending text behavior. Message inserted but not enqueued for inbound processing; `processedAt` remains null. |
| Pending + other button => invalid routed to `session_choice`; sessao button routed correctly | PASS | `webhook-whatsapp.ts:411-440`; handler `process_session_choice` invalid/resend; `sessao:continuar`/`sessao:nova` go to `process_session_choice`. |
| Dedup preserved | PASS | Webhook dedup via `claimWhatsAppWebhookEvent` (existing behavior); handler idempotency keys; tests confirm no duplicate outbound/reminder. |
| Handlers: ask sends exact texts+buttons `sessao:continuar`/`sessao:nova` once, sets `questionMessageId` | PASS | `handleAskSessionChoice`: creates assistant message with `SESSION_CHOICE_QUESTION_TEXT`, enqueues buttons, calls `setQuestionMessage` in transaction. Test confirms 1 outbound buttons, 1 assistant message, `questionMessageId` set. |
| Remind sends reminder once, doesn't duplicate question; no pending => skipped | PASS | `handleRemindSessionChoice` uses reminder text/buttons, idempotent by key; skipped when no pending. Tests pass. |
| Message stays unprocessed while pending | PASS | Pending text path enqueues only `remind_session_choice`, does not insert `process_inbound_message` task. |

## Targeted runs
- `TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5433/mariana_session_choice RELIABILITY_WORKERS_ENABLED=false npx tsx --import ./src/tests/support/db-test-preload.ts --test src/tests/routes/webhook-whatsapp.test.ts src/tests/reliability/session-choice-store.test.ts src/tests/reliability/session-choice-handlers.test.ts src/tests/session-choice-policy.test.ts`  
  → tests 27, pass 27, fail 0
- `npx tsx --import ./src/tests/support/unit-test-preload.ts --test src/tests/session-choice-policy.test.ts` (unit)  
  → 6/6 pass
- Full suites: `npm run test:db` (473 pass/0 fail per progress), `npm run test:unit` (253 pass/0 fail).  
- Static: `npx tsc --noEmit` clean; `npm run build` success; `npx biome check` on changed files clean (style notes non-blocking); `git diff --check` clean.

## Adversarial
- Duplicate webhook while pending: dedup prevents duplicate reminder/outbound (idempotency keys + webhook claim). Verified by design/tests.
- Duplicate tap: `process_session_choice` returns "já registrada" if already resolved or dedupes; claim is conditional (one winner). Verified.
- Button while pending invalid: routed to `process_session_choice` with kind invalid → resends question with buttons, no scheduling action. Verified.

## Notes
- No product code changes outside steps 4–5 scope. No git writes. DB target printed as requested. Guard rejects Neon.
- Full handler logic for "continue/new" beyond minimal stubs is planned for later steps (6-7); behavior for ask/remind/invalid/pending-text/gap decision is implemented and tested.
