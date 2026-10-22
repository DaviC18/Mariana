# Test report — Package A: Batch A defect fixes + Batch B (steps 4–6)

Tester run, 2026-10-22. Everything below was re-run by me; no claim from `progress.md` is taken on trust. No database was used, no Gemini/Google/WhatsApp call was made, `.env` was not touched, `RELIABILITY_WORKERS_ENABLED=false` in every run, and no version-control write command was run (the `block-git.sh` hook never fired).

## Verdict

| Item | Verdict |
|---|---|
| D-1 fix (test decoupled from `.env`) | **PASS** |
| D-2 fix (blank `GEMINI_TEMPERATURE`) | **PASS** |
| My Batch A file registered and unmodified | **PASS** |
| Step 4 — `src/lib/turn-trace.ts` | **PASS** |
| Step 5 — `agent.ts` records L0–L4 | **PASS** |
| Step 6 — `composeStageReplyWithTrace` (L6–L9) | **PASS with one defect (B-1)** |
| Network incident of step 5's red run | **ACCEPTED as reported, but the protection is the fake credential plus ad-hoc per-test mocks — no structural block. Finding B-2.** |

New defects: **B-1** (medium-low, implementer), **B-2** (medium, planner/implementer — test-safety), **B-3** (medium, planner — step 7 design gap). None blocks Batch C, but B-3 should be decided before step 7 is written.

## Suites I ran

```
npm run test:unit                        →  ℹ tests 228  ℹ pass 228  ℹ fail 0   (confirms the implementer's 228/0)
npx tsc --noEmit                         →  exit 0, no output
npm run build                            →  CJS dist/server.js 1.40 MB — Build success
git diff --check                         →  exit 0
npx ultracite check <the 8 changed source files>  →  Checked 8 files in 4s. No fixes applied.
npx ultracite check src/tests/turn-trace-adversarial.test.ts  →  Checked 1 file. No fixes applied. (after I fixed my own 5)
my file alone                            →  # tests 9  # pass 9  # fail 0
whole test:unit list + my file, external network blocked  →  # tests 237  # pass 237  # fail 0, zero NETWORK_ATTEMPT
tuned env (MEDIUM/0.7/gemini-2.5-pro/4096), the 4 config+trace files  →  26 tests, 0 fail
```

`npm run test:db` was not run: Batch B adds no DB code, no schema change and no migration, and `logTurnTrace` has no production caller yet, so a DB run would exercise nothing new. Neon was never contacted; no container was written.

## Batch A defect fixes

**D-1 — PASS.** `src/tests/agent-model-config.test.ts` now asserts `config.temperature === env.GEMINI_TEMPERATURE`, `config.maxOutputTokens === env.GEMINI_MAX_OUTPUT_TOKENS`, `config.thinkingConfig?.thinkingLevel === ThinkingLevel[env.GEMINI_THINKING_LEVEL]`, `resolveModelName() === env.GEMINI_MODEL`, and the literal `"gemini-3.5-flash-lite"` assertion is gone from test 2. My own reproduction now passes:

```
GEMINI_THINKING_LEVEL=MEDIUM GEMINI_TEMPERATURE=0.7 GEMINI_MODEL=gemini-2.5-pro GEMINI_MAX_OUTPUT_TOKENS=4096 \
  npx tsx … --test agent-model-config + gemini-model-config-adversarial + turn-trace + turn-trace-adversarial
  → 26 tests, 0 failures
```

The literal owner defaults are still pinned twice against an explicit `VALID_SOURCE`, so tuning `.env` cannot hide a changed default: `src/tests/env.test.ts` "parseEnv aplica os defaults do Gemini" and my "os defaults do dono são os do envSchema".

**D-2 — PASS, and the asymmetry is correct and intentional.** `src/env.ts:107` is `GEMINI_TEMPERATURE: source.GEMINI_TEMPERATURE?.trim() || undefined`; the other three are unchanged. Verified on all four, one process each:

```
GEMINI_MODEL="   "             →  - GEMINI_MODEL …            (throws, names the variable)
GEMINI_THINKING_LEVEL="   "    →  - GEMINI_THINKING_LEVEL …    (throws)
GEMINI_MAX_OUTPUT_TOKENS="   " →  - GEMINI_MAX_OUTPUT_TOKENS … (throws)
GEMINI_TEMPERATURE="   "       →  "temperature":0.3            (approved default, no longer 0)
```

The reasoning holds on both counts. Trimming `GEMINI_MODEL` or `GEMINI_THINKING_LEVEL` would make `" gemini-3.5-flash-lite"` and `"LOW "` silently *valid*, which is the opposite of what the owner decisions need — those two are matched against an exact shape, so padding is a configuration error worth surfacing (and my file asserts exactly that at `gemini-model-config-adversarial.test.ts:59,72`). Trimming `GEMINI_MAX_OUTPUT_TOKENS` would turn a blank value from a throw into a silent `1024`. So the single-variable trim is the minimal fix that removes the bogus `0` without weakening anything.
Residual note, not a defect: blank-with-spaces temperature now yields the default while a blank *cap* throws. An empty string (`GEMINI_X=`) already yields the default for all four, so the inconsistency is only between `""` and `"   "` on one variable. Harmless; mentioned so nobody "fixes" it by trimming everything.

**My Batch A file — PASS.** `src/tests/gemini-model-config-adversarial.test.ts` is in the `test:unit` list of `package.json`, still has its 28 assertions, and still carries the load-bearing lines (`ANY_MODEL_LITERAL = /["'`]gemini-[0-9]/`, the `" gemini-3.5-flash-lite"` and `"LOW "` invalid cases). Nothing was weakened or rewritten.

## Step 4 — `src/lib/turn-trace.ts` — PASS

Checked against `## Design` item 1 line by line:

| Design requirement | Result |
|---|---|
| `RewriteLayer` = the twelve audit ids L0…L11 | PASS — identical set and spelling; asserted by my test from the module source |
| `RewriteRecord` fields (`layer`, lengths, hashes, optional `detail`) | PASS — same fields, same optionality |
| `TurnTrace` = the 25 fields of the Design table (+ `event` added at log time) | PASS — all 25 present, none extra, none free-text |
| `hashText` = SHA-256 hex, first 12 chars, `node:crypto` | PASS — asserted against a hand-built `createHash` in the implementer's test |
| `logTurnTrace` emits exactly one `console.info(JSON.stringify({ event: "mariana_turn", … }))` | PASS |
| no import beyond `node:crypto` | PASS |
| four acceptance tests, red first | PASS — 4 tests present and meaningful (`Cannot find module '../lib/turn-trace'` is a credible red) |

The privacy mechanism is real: every field of `TurnTrace` is a number, a hash, an enum or an id, so no client or model text can reach the line by accident. The implementer's privacy test is stronger than the plan asked (it also asserts the reply text itself is absent), and the fixture-UUID correction is right — the old zero-padded ids contained a 12-digit run, which made the "no 11-digit sequence" assertion pass for the wrong reason.

**Acceptance-criterion marker.** Nothing was invented and nothing was resolved. The three pending markers are untouched at `plan.md:188` (step 2), `plan.md:233` (step 7) and `plan.md:264` (step 11), verbatim: *"criterion derived from Davi's brief — redação de R-REL-07 não disponível, pendente de confirmação."* / *"… S-17 …"*. `grep -rn "R-REL-07\|S-17" src/` → no hits, so no spec prose leaked into code or tests. One correction to the brief I was given: **step 4 of the plan body carries no marker** — the plan's header says "steps 4, 7 and 11" but the markers actually sit at steps 2, 7 and 11. That is a pre-existing planner-side numbering slip in `plan.md`, not something Batch B introduced.

## Step 5 — `agent.ts` records L0–L4 — PASS

Verified by running real turns through the seam (`generateContentFn`), with the real client trapped:

| Path | Input | Result |
|---|---|---|
| L0 | level-3 question | `rewrites: ["L0_level3_short_circuit"]`, raw length 0, `hashBefore === hashText("")`, model never called |
| L1 | reply `"Seja bem-vindo à Ademicon. …"` | `rewrites: ["L1_identity_sanitizer"]`, `hashBefore === hashText(rawReply)`, `hashAfter` differs |
| L3 | level-2 question `"o que e lance?"` + reply `"… Recomendo um lance de 30%."` | `rewrites: ["L3_evidence_handoff"]`, `hashAfter === hashText(result.reply)`, `commercialAccessLevel === 2` |
| L2 | invalid `evidenceUsed` id | **throws** `…unavailable knowledge evidence`, `error.turnRewrites === ["L1_identity_sanitizer"]` |
| L4 | reply `"Somos a Ademicon. Seja bem-vindo à Ademicon."` | **throws** `…guardrails…`, `error.turnRewrites === ["L1_identity_sanitizer"]` |
| clean turn | ordinary reply | `rewrites: []`, `rawReplyLength === 17`, `rawReplyHash === hashText(reply)`, `finishReason === "STOP"`, `requestedNextAction === "continue_qualification"` |

So L2 and L4 still throw, behaviour unchanged, and the partial records really do survive on the error. The implementer's own tests cover only L0 and the clean turn; **L1, L3, L2's carrier and L4's carrier had no test** — I wrote those four. The level-3 metadata's hard-coded `requestedNextAction: "request_consultant"` matches the literal the same branch parses, so it does not lie.

`model: response.modelVersion ?? resolveModelName()` and the `callModel` default (`ai.models.generateContent`) are unchanged in behaviour; the implementer's third test asserts the default really reaches the real client.

## Step 6 — `composeStageReplyWithTrace` (L6–L9) — PASS, with defect B-1

**Behaviour identity: proved, beyond the implementer's claim.** The implementer's "byte-identical regression guard" is three hard-coded fixtures whose expected strings were written *after* the change, which proves little. I proved it differentially against the actual pre-change code: I extracted `composeStageReply` from `HEAD` (read-only `git show`) into a throw-away oracle module, ran **288 input combinations** (12 model replies × 2 questions × 3 previous messages × apologize × isFirstContact) through old and new, and compared:

```
cases=288 mismatches=0
```

`composeStageReplyWithTrace(input).reply === composeStageReply(input) === old composeStageReply(input)` in all 288 cases. The oracle file was deleted afterwards; the result is frozen into my committed test as a SHA-256 golden digest (`1cac965f10bf…`) over the 288 outputs **and** their layer sequences, so a future change to either the text or the layer order breaks a test. The refactor's one risky move — splitting the single `!endsWith("?") && (isFirstContact || !greeting)` predicate into two sequential filters — is logically equivalent (`filter` preserves order and the conjunction is order-free), and the apology/`onlyApology`/cap/question blocks are untouched.

Layer records: L6 `questionsDropped`, L7 `greetingsDropped`, L8 `{cap, sentencesTruncated}`, L9 `{fallbackText: "neutral_1"|"neutral_2"}` — the Design's set, with the label and never the client-visible fallback string. Recorded in execution order (L6 → L7 → L9 → L8 as produced; my test pins `["L6","L7","L8"]` for the cap case).

### Defect B-1 (medium-low, implementer) — the stage records do not chain to the raw reply hash

The plan's own example line (`plan.md:107`) shows `rawReplyHash` equal to the first rewrite's `hashBefore` (`9f2b7c41ad03`), i.e. an unbroken before/after chain. The stage records break that chain whenever `splitSentences` + re-join normalises the text, because `recordRewrite` hashes `sentences.join(" ").trim()` instead of the `modelReply` it was handed:

```
modelReply = "Oi, Davi!  O consórcio funciona por grupos.   Quer saber mais?"   (double spaces)
rawHash    99abcfaadcff len 62
L6 before  dbb40666000d len 59   layer L6_dropped_questions
```

Expected: the first stage record's `hashBefore`/`lengthBefore` describe exactly the text handed to the composer, so step 7 can verify a continuous chain raw → … → sent. Actual: 59 vs 62 and a different hash, with no record explaining the 3 missing characters. Same effect whenever `splitSentences` drops a punctuation-only fragment. Suspected cause: `recordRewrite(layer, before: string[], after: string[])` takes arrays, so the very first "before" is already the normalised join. Fix is small — give L6 the raw `modelReply` as its `before` (or emit an explicit normalisation record). The implementer's own test hides this because its fixture has no double spaces. I deliberately did **not** commit a red test for it; the implementer should add it red → green when fixing.

## The four declared deviations, judged

**1. Optional `metadata` fields — ACCEPTED for Batch B, but it needs a follow-up decision in step 7 (see B-3 below).**
The constraint is real: `src/tests/services/generate-mariana-response.test.ts`, `qualification-fallback-loop.test.ts` and `commercial-identity.test.ts` hand-build `GenerateMarianaReplyResult`, so required fields would have forced edits outside step 5's file list. Making them optional was the right call for this batch.
The risk the coordinator names is real but narrower than feared: the **sink** type `TurnTrace` has every field required, so the emitted line cannot silently lose a field. What *can* go wrong is `rewrites`: `metadata.rewrites ?? []` in step 7 would conflate "no layer changed the text" with "the producer did not report", and an empty `rewrites` array is exactly the trace's most load-bearing claim ("nothing rewrote her"). So the follow-up must be one of: (a) once step 7 may touch those three DB test files, make the six fields required; or (b) keep them optional and have step 7 distinguish a missing producer explicitly instead of defaulting to `[]`. As-is, with (a) or (b) pending, this is acceptable; without either, the trace can lie by omission.

**2. `type` → `interface` — ACCEPTED, the log line is unaffected.**
`JSON.stringify` serialises the runtime object literal built at the call site, so a declaration keyword and biome's member sorting cannot touch key order or content. Field names, types and optionality are the Design's. Confirmed on the emitted line: `{"event":"mariana_turn","actionBlockedReason":null,…}` parses, is single-line, and carries `usage.thoughtsTokens`. Note the one real consequence: `interface` members are *sorted* by the assist rule, so the Design table's order is no longer the declaration order — irrelevant to output, worth knowing when reading the file.

**3. Duplicated private `recordRewrite` — ACCEPTED, with a caveat.** The two copies are not identical twins: `agent.ts` takes strings, `conversation-stage.ts` takes string arrays and joins them. That is why defect B-1 exists in one copy and not the other, and it is the argument *for* one shared helper when step 7 adds the third producer (L5/L10/L11). Not a blocker at two copies; flag it for step 7.

**4. `isPureBackendText` sentence comparison — ACCEPTED, matches the Design's intent.** The Design says "`rewrites` containing any of L0, L3, L5, L9, L10, L11 *and* the final text sharing no sentence with the raw reply". The implementation is exactly that: `BACKEND_AUTHORED_LAYERS` is that six-element set, and "shares no sentence" is `every(final sentence ∉ raw sentences)` after whitespace normalisation and splitting on `.!?`. Correct on the L0 (raw `""`), L9 and L11 cases, and correctly `false` for pruning-only layers and for a surviving model sentence (my test adds the L8 and no-layer negatives). Two edges the Design does not cover, both acceptable but worth knowing: an empty `sentReply` returns `true`, and a sentence kept with changed punctuation or casing counts as "not shared", so a near-copy would be reported as pure backend text.

## The eleven layers — inventory, nothing silently missing

| Layer | Producer today | Status |
|---|---|---|
| L0, L1, L3 | `src/ai/agent.ts` | emitted, verified |
| L2, L4 | `src/ai/agent.ts` | **throw by design, no record is ever emitted**; the partial records travel on `error.turnRewrites` (verified) |
| L6, L7, L8, L9 | `src/services/conversations/conversation-stage.ts` | emitted, verified |
| L5, L10, L11 | step 7 (`persistAuthorizedAssistantReply` / the slot-offer replacement) | **not yet produced — Batch C scope, correctly absent** |

My test asserts the twelve ids declared in `turn-trace.ts` are exactly the audit/Design set, so no id can be renamed or dropped unnoticed. Step 7's checklist must add L5, L10 and L11; nothing else is outstanding.

### Finding B-3 (medium, planner) — the trace cannot say *which* guardrail threw

L2 and L4 never produce a record, and the planned step-7 field set has only `outcome: "guardrail_throw"`. So a throwing turn will be visible but unattributable: the log will not distinguish "invented `evidenceUsed` id" (L2, `validate-response.ts`) from "forbidden identity claim" (L4, `mariana-safety.ts`), which are different bugs with different owners — and F-08 is exactly the finding this package promises to make *visible*. The decision belongs to the planner before step 7 is written: either add a `guardrailLayer` field to `TurnTrace`, or have the two call sites push a zero-length `L2_…`/`L4_…` record before rethrowing (the ids already exist in the type and are otherwise dead).

## The network incident of step 5's red run

**What I confirmed.** `src/tests/support/fake-external-env.ts` sets `GEMINI_API_KEY: "test-gemini-api-key"`, and both preloads apply it before `src/env.ts` is evaluated — `unit-test-preload.ts` has no `dotenv/config` at all, and `db-test-preload.ts` does `Object.assign(process.env, FAKE_EXTERNAL_ENV, overrides)` *after* `import "dotenv/config"`, so the fake key wins in both suites. The `API key not valid` rejection is consistent with that: no real credential and no quota were used, and the production account was never reachable from that process.

**Current state.** No unit test attempts an external connection today. I re-ran the **entire** `test:unit` list (32 files) plus my file with external egress blocked — `fetch`, `http.request`, `https.request`, non-local `dns.lookup` and non-local `net.Socket.connect` all throwing and logging:

```
# tests 237  # pass 237  # fail 0      (zero NETWORK_ATTEMPT lines)
```

**Finding B-2 (medium) — the protection is the fake credential plus ad-hoc per-test mocks, not an inability to call out.** Stated plainly, as asked: nothing in the repository stops a request from leaving the machine. `src/ai/client.ts` builds a live `GoogleGenAI` at import time, and the only things standing between a test and `generativelanguage.googleapis.com` are (a) an invalid key, which makes the call *fail* rather than *not happen*, and (b) the `mock.method(ai.models, "generateContent", …)` traps the implementer added by hand in `agent-model-config.test.ts` (and which I reuse). The next red run of a not-yet-mocked path will call out again, exactly as step 5's did. The incident is therefore a process symptom, not a one-off.
What would close it, in the spirit of the already-approved step 16 (pure predicate, test-only, escape hatch): a preload-level egress guard in `unit-test-preload.ts` / `db-test-preload.ts` that throws on a non-local socket or `fetch` while `--test` is in `argv`/`execArgv`, with an `ALLOW_TEST_NETWORK=1` hatch for Package A2's sanctioned simulator run. The trap I used is 30 lines and caught nothing, which is the ideal outcome; I did not commit it, because a preload lives in `src/tests/support/` and belongs to the implementer's scope under an approved step. Recommend adding it to Batch E, where the other four test-isolation holes already live.

## My adversarial tests

New file: `src/tests/turn-trace-adversarial.test.ts` — 9 tests, 9 pass, lint-clean, `tsc` clean, no network, no DB.

1. `as doze camadas do tipo são exatamente as da auditoria, sem nenhuma a menos` — the ids in `turn-trace.ts` equal the audit L0–L11 set, 12 unique.
2. `L1 é registrada quando o saneador de identidade muda o texto` — record consistency (`lengthBefore`, `hashBefore === hashText(raw)`, 12-hex hashes, `hashAfter ≠ hashBefore`). Untested by the implementer.
3. `L3 é registrada quando a validação de evidência troca a resposta` — level-2 violation path; `hashAfter === hashText(result.reply)`, `commercialAccessLevel === 2`. Untested by the implementer.
4. `L2 ainda lança e o erro carrega os registros parciais` — throws, and `error.turnRewrites === ["L1_identity_sanitizer"]`. Untested.
5. `L4 ainda lança e o erro carrega os registros parciais` — same for the safety assertion. Untested.
6. `composeStageReply continua byte-idêntico à versão anterior ao step 6` — the 288-case golden digest described above.
7. `nenhum detail das camadas de estágio carrega texto livre` — the privacy rule enforced at the **producer**, not only at the sink: every `detail` value is a finite number or one of `neutral_1`/`neutral_2`, and no record contains the client's phone or a model sentence.
8. `as camadas de estágio são registradas na ordem em que rodam` — `["L6","L7","L8"]` with the expected counts and `cap: 3`.
9. `isPureBackendText não confunde poda com reescrita do backend` — L8-only and no-layer negatives.

**Action needed from the implementer:** add `src/tests/turn-trace-adversarial.test.ts` to the `test:unit` list in `package.json` (I may not edit it). Meanwhile:
`npx tsx --import ./src/tests/support/unit-test-preload.ts --test src/tests/turn-trace-adversarial.test.ts`.

## Invariants checked (`CLAUDE.md`)

| Invariant | How | Result |
|---|---|---|
| Never write to Neon | no DB run, no `drizzle/` file, no `db:*` script, `.env` untouched | holds |
| No real Gemini/Google/WhatsApp call | whole suite re-run with egress blocked, zero attempts; fake credentials in both preloads | holds today (see B-2) |
| `RELIABILITY_WORKERS_ENABLED=false` | set in every run; also pinned by the preload | holds |
| Conversation behaviour unchanged | 288-case differential proof on `composeStageReply`; L2/L4 still throw with their original messages; `generateMarianaReply` returns the same `result` | holds |
| The AI is never the authority on IDs, availability or authorization | the gate code is untouched; the trace only observes | holds |
| Duplicate inbound events / outbound never back to `pending` / `selectedSlotId` | no file on those paths is in the diff; no DB write added | holds |
| Privacy (no client text, no phone in the trace) | type-level + sink test + my producer test | holds |
| Migration freeze | no migration file, no migration command | holds |

Files in the diff vs. the plan's Batch B list: `src/lib/turn-trace.ts` (new), `src/tests/turn-trace.test.ts` (new), `src/ai/agent.ts`, `src/services/conversations/conversation-stage.ts`, `src/tests/services/conversation-stage.test.ts`, plus `src/tests/agent-model-config.test.ts`, `package.json` and `docs/CODEMAP.md` (registration rows) and the Batch A files already accepted. **Exactly the planned set, nothing extra.** `logTurnTrace` and `isPureBackendText` have no production caller yet, which is correct for Batch B — the Package A promise of "one line per turn" is not delivered until step 7.

## Risks not covered by tests

1. **B-1, B-2 and B-3 above** — the first two are mechanical, the third is a design decision owed before step 7.
2. **Nothing exercises the trace end to end yet.** Every Batch B test is a unit test on a part. The first real integration risk (one line per turn, no duplicate line, no line lost on the throw path) arrives with step 7 and needs the DB suite.
3. **`error.turnRewrites` is attached by mutation** on whatever `Error` the guardrail threw. If a future guardrail throws a frozen or non-`Error` value, the records are silently dropped (`withRewrites` returns the value unchanged). Acceptable today; a thrown non-`Error` would lose the records with no trace.
4. **Step 5's seam is only as good as the trap.** `generateContentFn` defaults to the real client by design (plan requirement), so every future test on this path must mock it; see B-2.
5. **The 288-case digest pins text, not intent.** A deliberate future change to the composer (Package C1/C2 explicitly plans one: stop deleting questions, raise the cap) will break my test *on purpose*. The fixing agent must regenerate the digest knowingly, not blindly.

## Manual WhatsApp checklist for the owner

Batch B must change nothing a client can see — that is the whole point, so the checklist is a null test. Send these from a real number with the app running, and compare against how she answered yesterday.

1. `oi` → the normal greeting. Then `oi` again in a new turn → the greeting must **not** repeat (that is the L7 layer; it is now recorded, not changed).
2. `me explica como funciona o consórcio` → at most three sentences, no question from the model, and the backend's own question at the end (L6/L8 unchanged).
3. `e você, qual seu nome?` (a question-only message, so her reply has nothing to keep) → she must answer with the neutral phrase, not silence (L9 unchanged).
4. `o que é lance?` → a conceptual answer with no percentage, no recommendation and no simulation; if she tries one, the reply must come back as the consultant hand-off (L3, now recorded — exactly the path I tested).
5. Nothing new appears in the logs yet: `grep '"event":"mariana_turn"' <log>` returns nothing until step 7 ships. If a line appears already, something is calling `logTurnTrace` outside the plan — report it.
