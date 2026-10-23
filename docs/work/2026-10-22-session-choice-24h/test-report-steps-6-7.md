# Test report — Steps 6–7 (session choice 24h)

Date: 2026-10-22  
Task: `2026-10-22-session-choice-24h`  
DB target: `host=localhost port=5433 db=mariana_session_choice` (RELIABILITY_WORKERS_ENABLED=false). No real Gemini/WhatsApp/Calendar call. No git writes. No product code changes. No migrations.

## Verdict

**PASS** — 0 failures.

- Targeted Step 6–7 + support tests: **25/25 pass**.
- `npm run test:db` (full): **491/491 pass**, 3 consecutive runs.
- `npm run test:unit`: **253/253 pass**.
- `npx tsc --noEmit`: clean. `npm run build`: success. Biome on changed files: clean. `git diff --check`: clean.

## 1. Plan approval and diff scope

- `plan.md:1` is **APPROVED**: `Status: APPROVED by Davi on 2026-10-22 — "aprovo"`. Q1 (durable state in `autonomous_tasks`), Q2 (status by appointment) and Q3–Q8 accepted in the Decision log.
- Diff is scoped to Steps 6–7 plus Step 8/9 parts the plan itself puts inside the Step 7 transaction. Nothing unjustified:

| Change | Step | Justified by |
|---|---|---|
| `autonomous-task-handlers.ts` — `handleProcessSessionChoice` continue branch + `createInboundTasksForMessages` | 6 | Step 6 acceptance tests |
| `autonomous-task-handlers.ts` — new branch: snapshot, close A, create B, move messages, expire session, copy opt-out/window, reset lead, enqueue B tasks, confirmation | 7 | Step 7 acceptance tests |
| snapshot + commercial reset (plan Step 8) | 7 (folded) | Plan `plan.md:229` explicitly lists `snapshot (Step 8)` inside the Step 7 transaction; Step 7 test `B não herda nenhum campo comercial de A` and the crux test require the reset to exist. |
| status by appointment date (plan Step 9) | 7 (folded) | Plan `plan.md:236` lists `8 (snapshot/reset)` as a Step 7 dependency; Step 7 test `nova conversa cria B …` asserts A `closed` / B `active`, and the Step 9 tests (`session-choice-new.test.ts:541-720`) guard B not being born in `confirmation`. Q2 approved. |
| `active-conversation.ts` used by the new branch | 3/7 | Step 7 change text: `criar B via helper sob lock`. |
| `enqueueTask` `executor` type relaxed `typeof db` → `Pick<typeof db,"insert">` | 6–7 | Needed so a `tx` is assignable; no behavior change. |
| `create-conversations.ts`, `webhook-whatsapp.ts` | 3/4 | Prior approved steps; unchanged by 6–7 except imports. |

- Files in the working diff (untracked new files + modified):
  `src/services/conversations/{autonomous-task-handlers.ts, active-conversation.ts, session-choice-policy.ts, session-choice-store.ts}`, `src/routes/whatsapp/webhook-whatsapp.ts`, `src/routes/conversations/create-conversations.ts`, `src/tests/routes/webhook-whatsapp.test.ts`, `docs/CODEMAP.md`, `package.json` (test list), and the new test files. No `drizzle/` change.

## 2. Acceptance tests — criterion → test → result

Every Step 6 and Step 7 acceptance test from the plan exists, is meaningful, and passes.

### Step 6 — handler `continuar` (`src/tests/reliability/session-choice-continue.test.ts`)

| Plan acceptance test | Test present | Result |
|---|---|---|
| same `conversationId`, all pending messages enqueued in order | `continuar mantém o mesmo conversationId e enfileira todas as mensagens pendentes em ordem` | PASS |
| history + commercial state preserved | `continuar preserva histórico e estado comercial` | PASS |
| does not repeat the 24h question | `continuar não repete a pergunta de 24h` | PASS |

Meaning: the order test inserts 3 messages with distinct `createdAt` and asserts one `process_inbound_message` task per message, ordered by `messages.createdAt`, each with `triggerMessageId` matching and `createdAt` copied from the message; `processedAt` stays null; exactly one active conversation, equal to A.

### Step 7 — handler `nova conversa` (`src/tests/reliability/session-choice-new.test.ts`)

| Plan acceptance test | Test present | Result |
|---|---|---|
| B same lead, A closed, nothing deleted | `nova conversa cria B com o mesmo lead, fecha A sem apagar nada` | PASS |
| pending messages moved to B and processed there | `mensagens pendentes são movidas para B e processadas lá` | PASS |
| confirmation sent, does not assume continuation | `a confirmação de conversa nova é enviada e não assume continuação` | PASS |
| A's active scheduling session expired, appointment kept | `sessão de agendamento ativa de A é expirada e o appointment não é apagado` | PASS |
| B inherits opt-out and customer window | `B herda opt-out e janela do cliente` | PASS |

### Step 8/9 tests folded into Step 7 (same file)

| Test | Result |
|---|---|
| `o estado guarda o snapshot comercial de A antes do reset` | PASS |
| `B não herda nenhum campo comercial de A` | PASS |
| `lead scheduled com reunião passada volta a new na conversa nova` | PASS |
| `reunião futura confirmada mantém scheduled e não é apagada` | PASS |
| `reunião futura cancelada não mantém scheduled` | PASS |

### Commercial-isolation crux

Plan Step 8 asserts three tests; the plan file `session-choice-new.test.ts` carries `snapshot` and `B não herda`. The **crux** test (`pergunta de imóvel em B não recebe estado de veículo de A`, `src/tests/reliability/session-choice-isolation.test.ts`) already exists — added by the interrupted run — and is meaningful:

- Seed lead with `objective="consórcio de carro"`, `consortiumType="veículo"`, `painPoint="trocar o carro"` in A.
- Run `sessao:nova`; assert lead fields are reset (`objective`/`consortiumType` = null).
- Insert `"quero consórcio de imóvel"` into B; call `generateMarianaResponse` with a stub `generateMarianaReplyFn` that captures `lead`, `history`, `conversationContext`.
- Assert `capturedLead.objective === ""`, `capturedLead.consortiumType === ""`, `capturedLead.painPoint === null`; history contains **no** A turn; stage is `greeting` and **not** `confirmation`; `doNotAsk` has no "não pergunte o tipo" and no vehicle text.

No test needed to be added (crux test was present). Mutation check proved it is not vacuous: commenting out the `objective: null` reset line makes the test **fail** (`✖ pergunta de imóvel em B não recebe estado de veículo de A`, `fail 1`). Restored immediately; working tree clean (`git diff --stat` unchanged, 0 mutation lines).

## 3. Status rule

Verified by `session-choice-new.test.ts:541-720`:

- future `confirmed` appointment → `status` stays `scheduled`, appointment intact (deleted? no). PASS.
- past `scheduled` appointment → `status = "new"`, `qualifiedAt = null`; B has 0 assistant history so its stage is not `confirmation`. PASS.
- future `cancelled` appointment → `status = "new"`. PASS.
- none → `new` (covered by `B não herda…` which asserts `qualifiedAt === null` and by the crux). PASS.

## 4. Adversarial

| Case | Test | Result |
|---|---|---|
| concurrent double claim → exactly one winner | `session-choice-store.test.ts::dois claims concorrentes têm exatamente um vencedor` (`Promise.all([claim continue, claim new])`) | PASS |
| duplicate tap / continue-then-new | `session-choice-adversarial.test.ts::continuar e depois nova: a primeira escolha vence e a segunda só informa` | PASS |
| new-then-continue | `session-choice-adversarial.test.ts::nova e depois continuar: B é a única ativa e A continua fechada` | PASS |
| restart with pending state | `session-choice-adversarial.test.ts::estado pendente sobrevive a restart e a escolha ainda é aplicada` (re-read from Postgres, applies choice) | PASS |
| never two active conversations | `session-choice-adversarial.test.ts::mensagem concorrente ao toque nova nunca deixa duas conversas ativas` + Step 3 `duas criações concorrentes…` + Step 7 tests | PASS |
| duplicate webhook button reply | `routes/webhook-whatsapp.test.ts` (`o mesmo buttonReply não deve ser processado duas vezes`) | PASS |

## 5. Commands run

Targeted (Step 6–7 + support):

```
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5433/mariana_session_choice \
RELIABILITY_WORKERS_ENABLED=false npx tsx --import ./src/tests/support/db-test-preload.ts --test \
  src/tests/reliability/session-choice-continue.test.ts \
  src/tests/reliability/session-choice-new.test.ts \
  src/tests/reliability/session-choice-store.test.ts \
  src/tests/reliability/active-conversation.test.ts \
  src/tests/reliability/session-choice-isolation.test.ts \
  src/tests/reliability/session-choice-adversarial.test.ts
→ tests 25 / pass 25 / fail 0
```

Full suite (`npm run test:db`, ran 3×) → `tests 491 / pass 491 / fail 0` each run.  
`npm run test:unit` → `tests 253 / pass 253 / fail 0`.  
`npx tsc --noEmit` → no output (exit 0). `npm run build` → `Build success in 667ms`.  
`npx biome check` on 8 changed code/test files → `Checked 8 files … No fixes applied`.  
`git diff --check` → clean (exit 0).

Passing logs omitted below the summary lines, per the task.

## 6. Flake characterization

- **File:** `src/tests/services/generate-mariana-response.test.ts`, test `um turno emite exatamente uma linha mariana_turn com as camadas que alteraram o texto` (line 874). Same mechanism is shared by the other trace tests in the file (`generate-mariana-response.test.ts:874-1150`) and by `src/tests/services/turn-trace-integration.test.ts`.
- **Cause:** the helper `captureTurnTraceLines()` (line 834) monkey-patches the process-global `console.info` and restores it in a `finally`. `logTurnTrace` (`src/lib/turn-trace.ts:187-189`) writes `console.info(JSON.stringify({event:"mariana_turn",...}))`. `node --test` runs **top-level tests inside one file concurrently** by default. When one trace test holds the patch while a sibling trace test emits its own line, the capturing test observes 0 or 2 lines instead of exactly 1, and `assert.equal(capture.lines.length, 1)` fails.
- **Proof (reproduced in isolation):** a scratch file with test `t1` stealing `console.info` for 300 ms and test `t2` emitting a matching line at 100 ms produced `t1_captured=0` and `fail 1` — the exact failure shape of the interrupted run.
- **Ruled out:** cross-file interference. `node --test` spawns one child process per test file (probe: PIDs `43711` vs `43712`, globals not shared). So the flake is *within-file* concurrency only, which is why it is load-sensitive: under the full 491-test suite the DB/CPU contention can push two trace tests to overlap.
- **Pre-existing vs introduced:** **pre-existing**. The file is **not in the diff** (`git diff --name-only` does not list it; `git diff --stat` for it is empty). It exists unchanged since base commit `595db13` (`git cat-file -e 595db13:src/tests/services/generate-mariana-response.test.ts` succeeds; `git log -1 595db13` = "Add comprehensive tests for turn tracing and guardrail handling"). Steps 6–7 touch `autonomous-task-handlers.ts`, `active-conversation.ts`, `webhook-whatsapp.ts` and new test files only — none of which share `console.info` with this test.
- **Impact:** test-only, non-functional. Observed in exactly one prior run; not reproduced in 3 full `test:db` runs, 5 isolated file runs, or a 4-file trace-focused run (31/31 pass) this session.
- **Fix (out of scope for a tester run; recommend for a later test-hardening step):** serialize the trace tests with `{ concurrency: 1 }` / `test.describe` serial, or replace the `console.info` patch with an injected logger/sink. No product code change is required.

## 7. Risks for Steps 10–12

1. **`session_choice_state` row lifecycle.** Durable pending state lives as a `completed` row in `autonomous_tasks`. Any future purge of completed tasks (no such routine exists today) destroys pending state. Steps 10–12 must not add such a purge.
2. **Step 10 not implemented yet.** `claimNextTask` does not yet skip non-`session_choice_*` tasks while a pending state exists, and the 4 scheduling handlers do not yet re-check `readPendingSessionChoice`. A scheduling task already `processing` when the state opens can still produce external effects until Step 10's gate lands. The plan's matrix "Nenhuma ação de agendamento antes da escolha" is **not yet proven**.
3. **Concurrency test depth.** `mensagem concorrente ao toque nova` is sequential (message inserted before the tap). True simultaneous message+tap with two transactions is only scheduled for Step 12. The single-active invariant is currently guaranteed by the lead `FOR UPDATE` lock in `getOrCreateActiveConversation`, not by a DB unique index — the index is behind the migration freeze (Step 0 BLOCKED).
4. **`enqueueTask` executor type is now structural** (`Pick<typeof db,"insert">`). Step 12's concurrent writers must pass a `tx` to preserve atomicity.
5. **Flaky trace capture** (this section) may resurface as more trace tests are added in later steps; isolate the capture or serialize those tests.
