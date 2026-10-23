# Test report — 2026-10-22-session-choice-24h (Steps 2–3)

Verdict: PASS

## Diff matches Steps 2–3 expectations
| Item | Status | Evidence |
|---|---|---|
| `plan.md:1` approved | OK | `Status: APPROVED by Davi on 2026-10-22 — "aprovo"` |
| New store/active-conversation | OK | `src/services/conversations/session-choice-store.ts`, `src/services/conversations/active-conversation.ts` |
| Webhook/route use helper | OK | `src/routes/whatsapp/webhook-whatsapp.ts:353-355`, `src/routes/conversations/create-conversations.ts:50-74` |
| Handler constant only (Step 2) | OK | `src/services/conversations/autonomous-task-handlers.ts:1086` `SESSION_CHOICE_STATE_TASK` |
| CODEMAP/progress updated | OK | `docs/CODEMAP.md` updated (3 new entries), `docs/work/2026-10-22-session-choice-24h/progress.md` updated |
| Unapproved changes? | NONE | Only planned files touched for Steps 1–3; no product code outside planned scope, no migrations/drizzle edits. |

## autonomous_tasks shape / behavior (vs schema)
| Check | Status | Evidence |
|---|---|---|
| `session-choice-state:<id>` idempotencyKey | OK | `session-choice-store.ts:49-51,96` |
| `taskType = "session_choice_state"` | OK | `session-choice-store.ts:99`, constant `SESSION_CHOICE_STATE_TASK` |
| `status = "completed"` never claimed | OK | stored as `completed` (99); claim filters `payload->>'state'='pending'` only (134-166); executor claim logic unchanged and test confirms idle/executor ignores (progress: "the executor stays idle on the completed state row") |
| Claim atomic (`UPDATE ... WHERE state='pending' RETURNING ...`) | OK | `claimSessionChoice` uses conditional UPDATE with RETURNING (147-166). Two concurrent claims → 1 winner, other `null` (test passes). |
| `runNextAutonomousTask`/executor ignores it | OK | Test: opening state + `executeNextAutonomousTask` leaves status idle; state remains. Uses `executeNextAutonomousTask` as in repo. |

## Lead lock / active conversation
| Check | Status | Evidence |
|---|---|---|
| `getOrCreateActiveConversation` does `SELECT FROM leads FOR UPDATE` | OK | `active-conversation.ts:30-35` |
| Creates only if none active | OK | selects active (41-47), inserts only if missing (53-57) |
| Concurrent transactions produce exactly 1 active | OK | test: two concurrent tx on same lead → 1 active, same id (progress). |
| `POST /conversations` uses helper | OK | route refactored to use helper in transaction (50-74); returns 201 on create, 200 if already exists. |
| Webhook uses helper | OK | webhook refactored (353-355). |
| Preserves existing behavior/idempotency | OK | route idempotent (twice → same id, 1 active); behavior preserved. |

## Commands run
| Command | Result |
|---|---|
| `DB target host=localhost port=5433 db=mariana_session_choice` (printed before DB run) | Printed as required. Guard: uses `TEST_DATABASE_URL` for DB tests; `RELIABILITY_WORKERS_ENABLED=false` set. Did not touch `mariana_test`, `mariana_impl_batch_d`, `mariana_tester_batch_c`, 5432, or Neon. |
| `npx tsx --import ./src/tests/support/db-test-preload.ts --test --test-reporter=dot src/tests/reliability/session-choice-store.test.ts src/tests/reliability/active-conversation.test.ts` | PASS (targeted: 7/7) |
| `TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5433/mariana_session_choice RELIABILITY_WORKERS_ENABLED=false npm run test:db \| tail -n 40` | PASS: `tests 468 / pass 468 / fail 0` |
| `npm run test:unit \| tail -n 20` | PASS: `tests 253 / pass 253 / fail 0` |
| `tsc --noEmit` | PASS (clean) |
| `npm run build` | PASS (`Build success in 701ms`) |
| `npx biome check` on changed files | PASS (7 changed code/test files: no fixes) |
| `git diff --check` | PASS (clean) |

## Added tests
- Unit: `src/tests/session-choice-policy.test.ts` (Step 1) — 4 tests (added to `package.json` test:unit)
- DB: `src/tests/reliability/session-choice-store.test.ts` (Step 2) — restart/read-back, concurrent claims (1 winner), executor ignores completed state, opening creates no `process_inbound_message`
- DB: `src/tests/reliability/active-conversation.test.ts` (Step 3) — concurrent creates → 1 active same id, existing returned without create, `POST /conversations` idempotent

## Not-run
None (all required runs executed with DB against localhost:5433/mariana_session_choice).

## Adversarial checks
| Case | Status | Evidence |
|---|---|---|
| Duplicate `openSessionChoice` (conflict DO NOTHING) | OK | `onConflictDoNothing` on idempotencyKey; returns null if exists (store.ts:92-105). |
| Claim already resolved | OK | WHERE requires `payload->>'state' = 'pending'` → returns null if resolved. |
| Reading missing state returns null | OK | `readPendingSessionChoice` returns null if not found/pending. |
| Webhook/route still dedup events | OK | Webhook still uses existing dedup/event handling; route behavior preserved. |
| No extra task created on open | OK | Test confirms opening creates no `process_inbound_message`. |

## Risks for Steps 4+
- **State in `autonomous_tasks` (Q1 approved)**: no TTL/FK; purge could break pending state. Mitigate with dedicated key/type and restart tests.
- **Concurrency**: guarantee relies on lead lock (no unique partial index). Any new writer must use `getOrCreateActiveConversation`.
- **Webhook order**: Step 4 must read old `lastCustomerMessageAt` before updating; use single `receivedAt` per event.
- **Pending gate**: Steps 4–10 must block scheduling/actions while pending (claim/executor/handlers) per plan.
- **Status/reset**: Steps 7–9 need snapshot/reset and lead status resolution (Q2 approved).

Files changed (Steps 2–3): `docs/CODEMAP.md`, `package.json`, `src/routes/conversations/create-conversations.ts`, `src/routes/whatsapp/webhook-whatsapp.ts`, `src/services/conversations/autonomous-task-handlers.ts`, `src/services/conversations/active-conversation.ts` (new), `src/services/conversations/session-choice-store.ts` (new), `src/tests/reliability/active-conversation.test.ts` (new), `src/tests/reliability/session-choice-store.test.ts` (new). (Step 1 files already present.)
