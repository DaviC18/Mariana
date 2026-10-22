# Test report — Package A: Batch B defect fix + Batch C (steps 7–8, P-1, P-2)

Tester run, 2026-10-22. Every number below was produced by my own run. No Gemini/Google/WhatsApp call was made, `.env` was not touched, `RELIABILITY_WORKERS_ENABLED=false` in every run, and no version-control write command was run (the `block-git.sh` hook never fired).

**Database target:** `localhost:5433/mariana_tester_batch_c` — a database I created on the `mariana-test-pg` container (user `postgres`, password read from the container environment and never printed). The pre-existing `mariana_test` on that container was not reset or touched; nothing on `5432` was touched; Neon was never contacted.

## Verdict

| Item | Verdict |
|---|---|
| B-1 fixed (chained records) | **PASS** |
| Shared `buildRewriteRecord` helper | **PASS** |
| My file registered and unmodified | **PASS** |
| Step 7 — assemble and emit | **PASS with defect C-1** |
| Step 8 — `turnId` = anchor task id | **PASS** |
| P-1 — `guardrailLayer` | **PASS** (verified end-to-end against the real agent) |
| P-2 — missing vs empty `rewrites` | **PASS** |

New findings: **C-1** (medium, planner — undeclared narrowing of step 7's catch, so a turn that dies after the model call emits no line), **C-2** (low — two fields still invent data on the guardrail path), **C-3** (low-medium — the `rawReplyHash` fallback is disclosed only by another field), **C-4** (medium-low, planner — `actionBlockedReason` discards information that demonstrably exists).

## Suites I ran

```
npm run test:unit                                  →  ℹ tests 240  ℹ pass 240  ℹ fail 0   (confirms the claim)
npx tsc --noEmit                                   →  exit 0, no output                   (confirms the claim)
npm run test:db  (localhost:5433/mariana_tester_batch_c, run 1)  →  ℹ tests 441  ℹ pass 441  ℹ fail 0
npm run test:db  (same target, run 2, back to back)             →  ℹ tests 441  ℹ pass 441  ℹ fail 0
npm run build                                      →  CJS dist/server.js 1.40 MB — Build success
git diff --check                                   →  exit 0
npx ultracite check <the 10 changed source files>  →  Checked 10 files in 5s. No fixes applied.
my new DB file alone                               →  # tests 4  # pass 4  # fail 0
unit suite (33 files) under my egress trap         →  # tests 240  # pass 240  # fail 0, zero NETWORK_ATTEMPT
DB suite under my egress trap                      →  # tests 441  # pass 441  # fail 0, zero NETWORK_ATTEMPT
```

The implementer reported **437** DB tests; I measure **441** because my four new tests are picked up by the `src/tests/**/*.test.ts` glob. Subtracting mine gives exactly 437 — claim confirmed. All three reported numbers (240 unit, `tsc` 0, 437 DB) are confirmed, none refuted.

Egress note: step 17 is approved but not built, so I re-ran both suites with `fetch`, `http.request`, `https.request`, non-local `dns.lookup` and non-local `net.Socket.connect` throwing (localhost allowed, so Postgres still works). Zero attempts in either suite — including the new DB tests that drive `handleProcessInboundMessage`.

## B-1 — PASS

Re-ran my own double-space reproduction against the new `RewriteChain`:

```
--- "Oi, Davi!  O consórcio funciona por grupos.   Quer saber mais?"  (62 chars)
raw                   99abcfaadcff 62
L6_dropped_questions  before 99abcfaadcff/62  after d63dc5d9e5e5/42  chained=true
reply                 d63dc5d9e5e5 42   chain-from-raw OK = true
--- same text, with a backend question and isFirstContact=false
L6  before 99abcfaadcff/62 after d63dc5d9e5e5/42 chained=true
L7  before d63dc5d9e5e5/42 after a0f490ca3343/32 chained=true
--- "Olá de novo!  Um. Dois. Três. Quatro. Cinco?"
L6 → L7 → L8 all chained=true, last hashAfter == reply hash
```

The first record now describes the real `modelReply`, double spaces included (62, not 59), and every later record starts where the previous one ended. My 288-case golden digest (`1cac965f10bf…`) still passes, which is the proof that the chaining fix changed no reply text and no layer order. The only remaining discontinuity is the backend question appended after the cap, which is deliberate and matches the plan's own example line (there too the last `hashAfter` differs from `sentReplyHash`).

## Shared helper — PASS

`grep` over `src/` excluding tests: `buildRewriteRecord` is defined once, in `src/lib/turn-trace.ts:123`; `recordRewrite` returns **no hits anywhere** (both private copies gone); the three producers (`src/ai/agent.ts`, `src/services/conversations/conversation-stage.ts`, `src/services/conversations/generateMarianaResponse.ts`) all import the one helper, including L5, L10 and L11. No third variant and no string/string-array asymmetry left.

## My file — PASS

`src/tests/turn-trace-adversarial.test.ts` is in the `test:unit` list (33 files now), still has its 9 tests with the original names and 39 `assert` calls, and `STAGE_GOLDEN_DIGEST` is byte-identical. Run: `# tests 9 # pass 9 # fail 0`. Nothing was weakened or rewritten.

## Step 7 — PASS, with defect C-1

Checked against the plan's step 7 item by item:

| Requirement | Result |
|---|---|
| `traceTurnId?: string` param | PASS (`generateMarianaResponse.ts:80,385`) |
| compose call uses `composeStageReplyWithTrace` | PASS; the `request_consultant` branch records L5 instead, and emits nothing when the text was already the hand-off |
| L5/L10 from `persistAuthorizedAssistantReply` | PASS — it returns `rewrites`, L5 on hand-off, L10 on unauthorised scheduling, `[]` when nothing changed (unit test asserts all three) |
| L11 inline at the slot offer | PASS — recorded only when the text actually changed; my DB test asserts `offer.hashAfter === trace.sentReplyHash` |
| exactly one `logTurnTrace` before the return | PASS — one emit at `:869` on the success path, one at `:564` on the guardrail path, a single `return` at `:888`, and no early return in between |
| guardrail catch emits one line and rethrows unchanged | PASS — see P-1 |

**Exactly one line, verified on every outcome I could produce:** normal turn with L6 (1 line), guardrail L4 (1), guardrail L2 (1), level-3 short circuit with L0 (1), scheduling offer with L11 (1), non-reporting producer (1), anchor-task turn through `handleProcessInboundMessage` (1). No double emission anywhere: on the guardrail path the emit is followed by `throw error`, so the success-path emit is unreachable.

### Defect C-1 (medium, planner to route) — a turn that fails after the model call emits no line at all

The plan's step 7 says: *"and a `try/catch` around **the whole turn** that logs `outcome: "guardrail_throw"` and rethrows."* The implementation wraps **only** the model call (`callModelForTurn`), and this narrowing was not declared as a deviation. Consequence, measured:

```
PROBE: scheduling availability throws after a successful model call
PROBE_LINES=0
  AssertionError  expected: 1  actual: 0
```

(`schedulingAvailabilityService.getAvailableSlots` rejecting; the same hole covers the three `throw new Error("Assistant message not found")` sites at `:766,:829,:861`, `throw new Error("Conversation not found")` at `:696`, and any DB failure in the transaction.) So the failure mode the package exists to end — a turn that produces nothing and says nothing — still exists for every post-model error, and those are precisely the errors that are hardest to diagnose from the outside.

I did **not** commit a red test for it, because the fix is a design decision, not a typo: logging a calendar or DB failure as `guardrail_throw` would be a lie, and `TurnOutcome` has no honest value for it (`model_error` is Batch D's). The planner should either (a) restore the plan's whole-turn catch with a new `turn_error` outcome, or (b) record explicitly that post-model failures are out of Package A's scope and why. Reproduction is three lines on top of my new DB file; I can hand it over.

## Step 8 — PASS

`src/services/conversations/autonomous-task-handlers.ts:196` adds `traceTurnId: task.id` inside `handleProcessInboundMessage`, i.e. the anchor task of that handler invocation — not the conversation id and not the trigger message id. The DB test in `src/tests/reliability/inbound-batch-claim.test.ts` drives `runAutonomousTasksUntilIdle` and asserts `lines.length === 1` and `JSON.parse(lines[0]).turnId === anchorTask.id`; the implementer's red output shows the old value was the conversation id, which matches the fallback `traceTurnId ?? activeConversation.id`. That fallback is still in place for callers that pass no id, which is correct: the trace keeps a usable id rather than `undefined`.

## P-1 — PASS

`TurnRewritesCarrier.turnGuardrailLayer?: RewriteLayer` is attached at both catch sites in `src/ai/agent.ts`, and `TurnTrace.guardrailLayer: RewriteLayer | null` carries it. The implementer's DB test uses a *synthetic* error with the marker assigned by the test, which does not prove the two halves fit together, so I tested the real path: `generateMarianaResponse` running the **real** `generateMarianaReply` with only `generateContentFn` faked.

- L4 (`"Somos a Ademicon. Seja bem-vindo à Ademicon."`) → one line, `guardrailLayer: "L4_safety_assertion"`, `outcome: "guardrail_throw"`, `rewrites: ["L1_identity_sanitizer"]`, `sentReplyHash`/`sentReplyLength` `null`, `pureBackendText: null`.
- L2 (`evidenceUsed: ["evidencia-que-nao-existe"]`) → one line, `guardrailLayer: "L2_evidence_invalid_id"`, and **not** `L4_safety_assertion`.

So the two guardrails are now distinguishable in the line, which is what P-1 asked for.

**The throw is unchanged.** My test captures the rejected value and asserts it is the same `Error`, with the original message (`/guardrails/`, `/unavailable knowledge evidence/`), still carrying `turnRewrites` and now `turnGuardrailLayer`. The code path is `catch → emitTurnTrace(...) → throw error` on the identical object: no wrapping, no re-creation, no message edit, and nothing is swallowed — an error without the marker is rethrown without any line, which keeps model failures for Batch D.

## P-2 — PASS

Route chosen (sink made explicit) satisfies the decision:

- `rewrites: RewriteRecord[] | null` + `rewritesReported: boolean`, and the only producer-to-sink expression is `response.metadata.rewrites ? [...] : null` — an empty array is truthy in JS, so a genuine "nothing rewrote her" is `[]` with `rewritesReported: true`, while a silent producer is `null` with `rewritesReported: false`. The two are never confused.
- `pureBackendText: boolean | null`, `null` whenever `rewrites`, the raw text or the sent text is unknown. Calling it `false` would indeed have been a guess; `null` is right.
- `grep` for `rewrites ??` / `rewrites || []` in `src/` (excluding tests) → **no hits**: nothing flattens a missing producer to an empty list.
- The three hand-built fixture files: `qualification-fallback-loop.test.ts` and `commercial-identity.test.ts` are not in the diff at all, and `generate-mariana-response.test.ts`'s `buildAiResponse` literal is unchanged (`latencyMs`, `model`, `usage` only) — new tests were appended, the fixture was not edited. `tsc` stays at exit 0.
- The DB test `um produtor que não reporta rewrites nunca vira lista vazia` pins all three fields; I re-ran it and also confirmed the positive side (`rewritesReported: true` with a real `[]` and with real records).

One consequence worth recording, not a defect: when the producer is silent, the backend records that *are* known (L5, L10, L11) are discarded with it, because the whole list becomes `null`. That is defensible — a chain with a missing first link cannot be read as a chain — but it does throw away true information. If Batch D or a later step wants it, the honest shape is `rewrites` plus a `rewritesFrom: "producer" | "backend_only"` marker.

## The four declared deviations, judged

**1. Five fields widened to `| null` — ACCEPTED.** Reporting `null` on the guardrail path beats inventing a hash of `""`, and the privacy property is untouched (no field whose type admits free text). It does go beyond the Design table, so it belongs in the plan's record, which it now is.
*But the principle is not applied consistently — finding C-2 (low):* `latencyMs: metadata?.latencyMs ?? 0` still reports a fabricated `0` on the guardrail path, and `modelVersionReturned: metadata?.model ?? null` reports the **configured** model name whenever the API omitted `modelVersion`, because the agent's `metadata.model` is already `response.modelVersion ?? resolveModelName()`. A field named "returned" that can hold a value nothing returned is the same class of problem the widening was meant to fix. Both are one-line fixes (`?? null`, and thread the real `response.modelVersion`).

**2. `rawReplyHash` / `pureBackendText` falling back to `response.result.reply` — ACCEPTED WITH CAVEAT (finding C-3).** It can mislead, and here is exactly how: `response.result.reply` is the agent's output *after* L1 and L3, so when the producer is silent the line reports a "raw reply hash" that is really the post-sanitiser text. A reader comparing `rawReplyHash` with `sentReplyHash` on such a line could conclude "nothing rewrote her" when L1 or L3 may well have fired. Two things keep it tolerable: `pureBackendText` is `null` in that case, so the load-bearing claim is not made, and `rewritesReported: false` is on the same line as a disclosure. Recommendation: when `rewritesReported === false`, set `rawReplyHash`/`rawReplyLength` to `null` too, or rename the fallback (`receivedReplyHash`). Mislabelled data is harder to spot than absent data.

**3. No record for pure normalisation — ACCEPTED, and the right call.** A thirteenth layer id would contradict the fixed twelve-layer inventory that both my tests and the audit depend on, and `rawReplyHash ≠ sentReplyHash` with `rewrites: []` is a readable signature for "text changed without a layer". The same applies to the backend question appended after the cap (my chain probe shows the last `hashAfter` differing from the reply hash), which the plan's own example line already exhibits.

**4. `actionBlockedReason` always `null` — the deviation's *reason* is inaccurate; finding C-4 (medium-low, planner).** It is true that `ExecuteNextActionResult` (`src/services/agent/execute-next-action.ts:123-143`) has only `executed`/`pending` branches. It is not true that there is nothing to report: the same file *has* blocked branches that log `{ event: "agent_action_blocked", reason: "no_current_scheduling_intent" | "lead_not_qualified", nextAction }` at lines 245, 260 and 289 and then silently downgrade the action to `continue_qualification`. That reason is precisely what the Design's `actionBlockedReason` ("from `executeNextAction`'s blocked branch, when present") asks for, and the trace now always says `null` while a separate log line carries the truth. Impact is limited — the two lines share `conversationId` and can be correlated — so this is not a step-7 blocker, but the field is misleading as shipped: `null` reads as "nothing was blocked". The fix needs `executeNextAction` to return the reason, which is outside step 7's file list, so the planner should route it (Batch C follow-up or Package B).

**5 (also declared). `executedAction = nextActionResult.action` only.** Accepted. `status` is only ever `pending` for `schedule_meeting` and `executed` elsewhere, so the action value already implies it. No information is lost in practice.

## My adversarial tests

New file: `src/tests/services/turn-trace-integration.test.ts` (DB suite, 4 tests, all passing, lint-clean, `tsc` clean, no real model call — the agent always receives a fake `generateContentFn`).

1. `um guardrail real de identidade (L4) vira uma linha com a camada que lançou` — the real agent throws, one line, `guardrailLayer: L4`, the nulls on the sent side, `rewrites: ["L1_identity_sanitizer"]`, and the rejected error is asserted to be the same unchanged `Error` with its carrier intact.
2. `um guardrail real de evidência (L2) é distinguível de L4 na linha` — the end-to-end proof of P-1's purpose.
3. `L11 é registrada e encadeada quando a oferta de horários troca o texto` — L11 existed in no test before this; also asserts `hashAfter === sentReplyHash`, `rawReplyHash === hashText(modelReply)`, and that the consultant's name, the lead's phone and any 11-digit run are absent from the line.
4. `o rastro nunca repete nem omite a linha quando o texto é 100% do backend` — level-3 short circuit: exactly one line, `L0` recorded, `commercialAccessLevel: 3`, `pureBackendText` a real boolean.

Plus the uncommitted probes: the double-space chain reproduction (B-1) and the post-model failure probe (C-1, `PROBE_LINES=0`).

**Action needed from the implementer:** nothing for registration — my file is in the DB glob and runs automatically (441 = 437 + 4). It opens no network; it does create and leave one lead/conversation per test, like the neighbouring tests in that suite.

## Invariants checked (`CLAUDE.md`)

| Invariant | How | Result |
|---|---|---|
| Never write to Neon | DB runs pinned to `localhost:5433/mariana_tester_batch_c`, printed by the guard; `.env` untouched; no `db:*` command | holds |
| No real Gemini/Google/WhatsApp call | both suites re-run under the egress trap, zero attempts; the new reliability test mocks `ai.models.generateContent`; my tests inject `generateContentFn` | holds (structurally still unguarded until step 17) |
| `RELIABILITY_WORKERS_ENABLED=false` | set in every run | holds |
| A duplicate inbound event is never processed twice | step 7 adds no DB write and no early return; the emit sits after every write; the anchor-task test still passes, and the whole reliability suite is green twice | holds |
| An outbound message that may have been accepted never goes back to `pending` | no outbound code touched | holds |
| A clear affirmative / pending-offer marker | `pending-offer` suite untouched and green | holds |
| The AI is never the authority on IDs, availability or authorization | the gate is untouched; L5/L10 record the *backend's* overrides, they do not weaken them | holds |
| Conversation behaviour unchanged | 288-case golden digest still green; L2/L4 still throw with the original errors; 441 DB tests green twice | holds |
| Privacy — no client text, no phone, no reply text in the line | type-level, plus the implementer's DB assertions, plus my offer-path assertions (consultant name, phone, 11-digit run) | holds |
| Migration freeze | no `drizzle/` change, no migration command | holds |

Files in the diff vs. the plan's Batch C list: `generateMarianaResponse.ts`, `autonomous-task-handlers.ts`, `src/ai/agent.ts` (P-1), `src/lib/turn-trace.ts` (P-1/P-2/P-3), `conversation-stage.ts` (B-1), and the four test files. **Exactly the planned set plus the two planner decisions.** `logTurnTrace` now has a production caller, so Package A's "one line per turn" promise is live for the two outcomes implemented; `model_error` arrives with Batch D.

## Risks not covered by tests

1. **C-1** — no line on a post-model failure. Not covered by any committed test, deliberately; the hole is real and measured.
2. **C-4** — a blocked action is invisible in the trace line; nothing tests the field because there is nothing to test yet.
3. **Log volume and PII at scale.** One JSON line per turn with `rewrites` can be a few hundred bytes; nothing here rotates or samples it. Out of scope, but the first production day will show it.
4. **`console.info` as the transport.** Any other `console.info(string)` containing `"event":"mariana_turn"` would be captured by the test helpers and, more importantly, the line has no sink configured — it relies on the platform's stdout capture.
5. **The guardrail line reports `requestedNextAction: "unknown"` and `executedAction: "none"`.** Two invented sentinel strings, undeclared. Harmless, but a reader cannot distinguish them from a real action named `none`.
6. **Still no end-to-end test with a real Gemini response shape** (the API is never called here, correctly). `finishReason`, `usage.thoughtsTokens` and `modelVersion` are only ever exercised from fixtures.

## Manual WhatsApp checklist for the owner

Batch C is the first step where something becomes visible in the logs. Nothing a client sees may change.

1. Send `oi`, then `me explica como funciona o consórcio`. Expected: the same replies as before (at most three sentences plus her question). Then `grep '"event":"mariana_turn"' <log> | wc -l` → exactly **2**, one per turn.
2. On the second line, check `jq '{turnId, outcome, rewrites: [.rewrites[].layer], rewritesReported, guardrailLayer}'`: `outcome: "replied"`, `rewritesReported: true`, `guardrailLayer: null`, and `turnId` equal to the task id in `autonomous_tasks` for that message.
3. Confirm the line carries **no** text: it must contain neither your words, nor her reply, nor the phone number. If it does, stop and report — that is a privacy regression.
4. Ask `qual o valor da carta de 300 mil?` → she hands off to a consultant, and the line shows `L0_level3_short_circuit` with `commercialAccessLevel: 3`.
5. Ask to schedule when you are qualified (`pode me passar os horários?`) → the slot offer arrives, and the line shows `L11_slot_offer_replaced` whose `hashAfter` equals `sentReplyHash`.
6. Known gap (C-1): if a turn ever goes silent and no `mariana_turn` line appears at all, that is this batch's open hole, not a mystery — report the timestamp so it can be matched to the task failure.
