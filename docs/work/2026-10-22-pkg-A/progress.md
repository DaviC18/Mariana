# Progress — Package A ("Enxergar e proteger")

## Batch A — model config (steps 1–3)

Implementer run, 2026-10-22. Approval gate checked: `plan.md` line 1 is
`Status: APPROVED by Davi — 2026-10-22.`, with the written caveat that item 1
(the `R-REL-07` / `S-17` wording) stays unresolved and that Davi chose to start
Batch A anyway. Unit tests only; no database, no migration, no network call to
Gemini or any Google API; `.env` not touched.

### Step 1 — `env.ts`: the four Gemini variables

Files changed:
- `src/env.ts` — added `GEMINI_MAX_OUTPUT_TOKENS`, `GEMINI_MODEL`,
  `GEMINI_TEMPERATURE`, `GEMINI_THINKING_LEVEL` to `envSchema` (alphabetical
  order, after `GEMINI_API_KEY`) and to `buildEnvInput` as
  `source.X || undefined`, so an invalid value fails validation instead of
  silently falling back (same pattern as `WHATSAPP_SEND_TIMEOUT_MS`).
- `src/tests/env.test.ts` — three new tests plus four error regexes.

Defaults implemented exactly as the owner decided: model
`gemini-3.5-flash-lite`, temperature `0.3`, thinking level `LOW`, max output
tokens `1024`.

RED (`npx tsx --import ./src/tests/support/unit-test-preload.ts --test --test-reporter=tap src/tests/env.test.ts`):

```
✖ parseEnv aplica os defaults do Gemini
  AssertionError [ERR_ASSERTION]: actual: undefined, expected: 'gemini-3.5-flash-lite'
✖ parseEnv recusa um nome de modelo fora do formato
  AssertionError [ERR_ASSERTION]: Missing expected exception. expected: /GEMINI_MODEL/
✖ parseEnv recusa temperatura e nível de raciocínio inválidos
  AssertionError [ERR_ASSERTION]: Missing expected exception. expected: /GEMINI_TEMPERATURE/
# tests 11 / pass 8 / fail 3
```

GREEN (same command): `# tests 11 / # pass 11 / # fail 0`.

### Step 2 — `agent.ts`: use the configuration

Files changed:
- `src/ai/agent.ts` — removed `const MODEL = "gemini-3.5-flash-lite"` (old line
  36); added the pure `buildModelRequestConfig({ systemInstruction })` returning
  `GenerateContentConfig` with `temperature`, `maxOutputTokens`,
  `thinkingConfig.thinkingLevel` from `env`, plus the unchanged
  `responseJsonSchema` / `responseMimeType`; added `resolveModelName()`; the
  three former `MODEL` references (the `generateContent` call site, the level-3
  short-circuit metadata, the `response.modelVersion ?? …` fallback) now use
  `resolveModelName()`.
- `src/tests/agent-model-config.test.ts` — new unit file.
- `package.json` — new file added to the `test:unit` list (first entry).
- `docs/CODEMAP.md` — the `src/ai/agent.ts` row no longer names `MODEL`; it
  names `resolveModelName` and `buildModelRequestConfig`.

No test calls the API: `buildModelRequestConfig` is pure and `ai` stays a
module-level singleton that performs no request at import time.

RED (`… --test-reporter=tap src/tests/agent-model-config.test.ts`):

```
not ok 1 - buildModelRequestConfig envia modelo, temperatura, nível de raciocínio e limite de saída
  error: '(0 , import_agent.buildModelRequestConfig) is not a function'
not ok 2 - o modelo vem do ambiente, não de uma constante
# tests 2 / pass 0 / fail 2
```

GREEN (same command): `# tests 2 / # pass 2 / # fail 0`.

Type error found and fixed during the step: the SDK's `thinkingLevel` is the
`ThinkingLevel` enum, not a string union, so `tsc` rejected the plain env
string (`src/ai/agent.ts(64,21): error TS2322: Type '"HIGH" | "LOW" | "MEDIUM"
| "MINIMAL"' is not assignable to type 'ThinkingLevel | undefined'`). Fixed by
indexing the enum: `ThinkingLevel[env.GEMINI_THINKING_LEVEL]`. The enum values
are the identical strings, so the test's `"LOW"` assertion still holds.

### Step 3 — document the variables in `.env.example`

File changed: `.env.example`, the "AI - Google Gemini (required)" block. Four
commented entries with the defaults, including the note that
`GEMINI_THINKING_LEVEL` replaces a token budget because Gemini 3.5 rejects
`thinkingBudget` with a user error. `.env` itself was not touched — Davi sets
the real values.

Proof (documentation step, no automated test):

```
grep -c GEMINI_ .env.example  →  5
names in .env.example : GEMINI_API_KEY GEMINI_MODEL GEMINI_TEMPERATURE GEMINI_THINKING_LEVEL GEMINI_MAX_OUTPUT_TOKENS
names in envSchema    : GEMINI_API_KEY GEMINI_MAX_OUTPUT_TOKENS GEMINI_MODEL GEMINI_TEMPERATURE GEMINI_THINKING_LEVEL
```

Same five names on both sides.

### Batch verification

```
npm run test:unit   →  ℹ tests 208 / ℹ pass 208 / ℹ fail 0
npx tsc --noEmit    →  no output, exit 0
npx ultracite check src/env.ts src/ai/agent.ts src/tests/env.test.ts src/tests/agent-model-config.test.ts
                    →  Checked 4 files in 5s. No fixes applied.
```

`npm run test:db` was not run: no step in this batch touches the database or the
schema. No migration command was run (freeze respected). Nothing was placed in
version control.

### Deviations from the plan

1. **`resolveModelName()` added** (step 2). The plan says to remove the `MODEL`
   constant and read `env.GEMINI_MODEL`, and its acceptance test asserts that
   "the resolved model equals `env.GEMINI_MODEL`" — but the planned
   `buildModelRequestConfig` signature returns `GenerateContentConfig`, which
   has no `model` field, so there was no exported seam to assert against. A
   one-line pure `resolveModelName()` is that seam, and the three call sites use
   it. The test also asserts, by reading `src/ai/agent.ts`, that no
   `const MODEL = "gemini-…"` hard-coding comes back.
2. **`ThinkingLevel` enum indexing** instead of passing the env string
   directly, forced by the SDK typings (see step 2 above).
3. **`docs/CODEMAP.md` test list**: the plan asks for the new test file to be
   added to CODEMAP, but CODEMAP has no per-file unit-test list — it points at
   `package.json` ("A new unit test file must be added there"), which was done.
   The CODEMAP edit made instead was the `src/ai/agent.ts` symbol row.

### Still open (not this batch's work)

The plan's own blocker stands: `R-REL-07` / `S-17` wording is unavailable, so
final acceptance of step 2 against the spec remains open. The step-2 criterion
stays marked as derived from Davi's brief.

## Batch A — defect fixes (from `test-report-batch-A.md`)

Both defects were assigned to the implementer. Unit tests only; no DB, no
migration, no `.env` edit, nothing placed in version control.

### D-1 (medium) — the test went red as soon as `.env` was tuned

Reproduced first, exactly as the tester reported:

```
GEMINI_THINKING_LEVEL=MEDIUM GEMINI_TEMPERATURE=0.7 npx tsx --import ./src/tests/support/unit-test-preload.ts \
  --test --test-reporter=tap src/tests/agent-model-config.test.ts
not ok 1 - buildModelRequestConfig envia modelo, temperatura, nível de raciocínio e limite de saída
  expected: 0.3
  actual: 0.7
# tests 2 / pass 1 / fail 1
```

Fix (test code only, no product change): `src/tests/agent-model-config.test.ts`
now asserts against `env.GEMINI_TEMPERATURE`, `env.GEMINI_MAX_OUTPUT_TOKENS`,
`ThinkingLevel[env.GEMINI_THINKING_LEVEL]` and `env.GEMINI_MODEL`, and the
literal `"gemini-3.5-flash-lite"` assertion was dropped from test 2. The owner
defaults stay pinned in `src/tests/env.test.ts` and in the tester's file, both
of which parse an explicit `VALID_SOURCE` and are immune to `.env`.

GREEN, under a tuned environment and under the defaults:

```
GEMINI_THINKING_LEVEL=MEDIUM GEMINI_TEMPERATURE=0.7 GEMINI_MODEL=gemini-2.5-pro GEMINI_MAX_OUTPUT_TOKENS=4096 …
  → # tests 2 / # pass 2 / # fail 0
(default environment)                        → # tests 2 / # pass 2 / # fail 0
```

### D-2 (low) — a whitespace-only `GEMINI_TEMPERATURE` became `0`

Two tests added to `src/tests/env.test.ts`. The second one confirms the
tester's "the other three are safe" claim instead of trusting it.

RED (trim temporarily backed out of `src/env.ts`):

```
not ok 12 - parseEnv não transforma uma GEMINI_TEMPERATURE em branco em zero
  expected: 0.3
  actual: 0
  operator: 'strictEqual'
# tests 13 / pass 12 / fail 1
```

The companion test `parseEnv recusa as outras três variáveis do Gemini em
branco` passed in that same red run — so `GEMINI_MODEL`, `GEMINI_THINKING_LEVEL`
and `GEMINI_MAX_OUTPUT_TOKENS` already reject `"   "` (two are text, and
`Number("   ") === 0` fails `min(128)`). Confirmed, not assumed.

Fix: `src/env.ts` → `GEMINI_TEMPERATURE: source.GEMINI_TEMPERATURE?.trim() || undefined`.
GREEN: `# tests 13 / # pass 13 / # fail 0`.

**The trim was applied to that variable only, deliberately.** A blanket
`.trim()` on all four would have broken the tester's own file, which requires
`GEMINI_MODEL=" gemini-3.5-flash-lite"` and `GEMINI_THINKING_LEVEL="LOW "` to
*throw* (`src/tests/gemini-model-config-adversarial.test.ts:59,72`). Trimming
`GEMINI_MAX_OUTPUT_TOKENS` would also have turned a blank value from a throw
into a silent default, which is worse. `Number` already ignores padding around
a real number, so nothing else is affected.

### Registering the tester's file

`package.json` → `src/tests/gemini-model-config-adversarial.test.ts` added to
the `test:unit` list, in alphabetical position. Its assertions were not
touched. Suite after the two fixes and the registration:
`ℹ tests 218 / ℹ pass 218 / ℹ fail 0` — 208 + the tester's 8 + the 2 new D-2
regression tests.

## Batch B — the trace module and the layer records (steps 4–6)

### Step 4 — `src/lib/turn-trace.ts`

Files: new `src/lib/turn-trace.ts`; new `src/tests/turn-trace.test.ts`;
`package.json` (`test:unit`); `docs/CODEMAP.md` (new row).

Contents: `RewriteLayer` (the twelve ids L0–L11), `RewriteRecord`,
`TurnOutcome`, `TurnTraceUsage`, `TurnTrace`, `hashText` (SHA-256 hex, first
12 chars), `isPureBackendText`, `logTurnTrace` (one `console.info` of one
`JSON.stringify` line). Only `node:crypto` is imported.

RED: `Error: Cannot find module '../lib/turn-trace'` → `# tests 1 / pass 0 / fail 1`.
GREEN: `# tests 4 / # pass 4 / # fail 0`.

One fixture correction during the step: the privacy test's own zero-padded
example UUIDs (`0f3c5a21-0000-4000-8000-000000000001`) contain a 12-digit run,
so the "no 11-digit sequence" assertion was failing on the trace's own ids
rather than on leaked text. The fixture now uses hex-mixed UUIDs, which makes
that assertion mean what it says.

### Step 5 — `agent.ts` reports L0–L4 and the raw reply

Files: `src/ai/agent.ts`; tests appended to `src/tests/agent-model-config.test.ts`.

`metadata` gained `commercialAccessLevel`, `finishReason`, `rawReplyHash`,
`rawReplyLength`, `requestedNextAction` and `rewrites`; `latencyMs`, `model`
and `usage` are unchanged. L0 is recorded on the level-3 short circuit (raw =
`""`), L1 when `sanitizeCommercialIdentity` changed the string, L3 when
`validateMarianaEvidence` replaced the reply. L2 and L4 still throw, and now
carry the partial records on the error as `turnRewrites` for step 7.

RED:

```
not ok 3 - metadata traz hash e comprimento da resposta crua
  error: '{"error":{"code":400,"message":"API key not valid…","status":"INVALID_ARGUMENT"…}}'
not ok 4 - o curto-circuito de nível 3 é registrado como L0
  expected: 3
# tests 5 / pass 3 / fail 2
```

**Note on that red run:** because the `generateContentFn` seam did not exist
yet, the first test fell through to the real client and a request did leave the
machine, rejected by the fake API key of `fake-external-env.ts`. No real
credential, no real usage — but it must not be possible, so both tests now
install a trap (`trapRealClient`) that makes `ai.models.generateContent` throw.
A future regression in the seam now fails the test instead of reaching the API.

GREEN: `# tests 5 / # pass 5 / # fail 0`.

The third test, `sem generateContentFn a chamada vai para o cliente Gemini
real`, mocks `ai.models.generateContent` and asserts it was called once — that
is the plan's "the default must be the real client" guard, and it passes both
before and after by design.

### Step 6 — `composeStageReplyWithTrace` (L6–L9)

Files: `src/services/conversations/conversation-stage.ts`; tests appended to
`src/tests/services/conversation-stage.test.ts`.

The body became `composeStageReplyWithTrace(input): { reply, rewrites }` and
`composeStageReply(input)` is now a one-line wrapper over `.reply`, so no
existing caller or test changed. Records: L6 `questionsDropped`, L7
`greetingsDropped`, L8 `{ cap, sentencesTruncated }`, L9
`{ fallbackText: "neutral_1" | "neutral_2" }` (the label, never the
client-visible string). The single old filter was split into two sequential
filters so questions and greetings are attributable to separate layers; the
resulting sentence set, and therefore the output text, is identical.

RED: `TypeError: (0 , import_conversation_stage.composeStageReplyWithTrace) is not a function` ×3.
GREEN: `# tests 27 / # pass 27 / # fail 0` (the file's 24 pre-existing tests
plus the 3 new ones, including the byte-identical regression guard over three
fixtures).

### Batch verification

```
npm run test:unit   →  ℹ tests 228 / ℹ pass 228 / ℹ fail 0
npx tsc --noEmit    →  no output, exit 0
npx ultracite check <the 8 changed source files>  →  Checked 8 files in 5s. No fixes applied.
```

`npm run test:db` was not run: no step in Batch B touches the database or the
schema, and no migration command was run. No network call, no Gemini call, no
Google API call, no write to Neon, `.env` untouched, nothing in version control.

### Deviations from the plan (Batch B)

1. **The new `metadata` fields are optional (`?`).** Three DB test files build
   `GenerateMarianaReplyResult` literals by hand
   (`src/tests/services/generate-mariana-response.test.ts`,
   `qualification-fallback-loop.test.ts`, `commercial-identity.test.ts`).
   Required fields would have broken `tsc` there and forced edits outside the
   files step 5 names. Step 7 must therefore read them defensively.
2. **`type` → `interface` in `turn-trace.ts` and for `TurnRewritesCarrier`.**
   The Design section writes `export type RewriteRecord = {…}`, but biome's
   `lint/style/useConsistentTypeDefinitions` rejects an object `type` alias, and
   `assist/source/useSortedInterfaceMembers` then sorts the members. The field
   names, types and optionality are exactly the Design's; only the declaration
   keyword and member order differ. Key order in the log line comes from the
   object literal at the call site, so the emitted line is unaffected.
3. **An 8-line private `recordRewrite` helper exists in both `agent.ts` and
   `conversation-stage.ts`.** Sharing it would mean exporting a fourth symbol
   from `turn-trace.ts`, and step 4 pins that module's contents. Worth
   revisiting in a later step if a third producer appears.
4. **`isPureBackendText` sentence comparison** is defined as: a
   backend-authoring layer (L0, L3, L5, L9, L10, L11) is present **and** no
   sentence of the final text appears among the raw reply's sentences
   (whitespace-normalised, split on `.`/`!`/`?`). The Design states the rule but
   not the comparison, so this is the implementation choice, unit-tested on the
   L0, L9 and L11 cases plus two negatives.

The step-4 acceptance criterion keeps its marker verbatim — `redação de
R-REL-07 não disponível — critério derivado do brief, pendente de
confirmação`. No spec wording was invented.

## Batch B — defect fixes (from `test-report-batch-B.md`)

### B-1 (medium-low) — the stage records did not chain to the raw reply hash

RED first, with the tester's own double-space fixture, in
`src/tests/services/conversation-stage.test.ts`:

```
not ok 28 - os registros do estágio encadeiam a partir da resposta crua
  expected: 62
  actual: 59
# tests 28 / pass 27 / fail 1
```

That is exactly the tester's measurement (`rawHash … len 62` vs
`L6 hashBefore … len 59`). The test asserts three things: the first record's
`hashBefore`/`lengthBefore` equal the raw `modelReply`, every later record's
`hashBefore`/`lengthBefore` equal the previous record's `after`, and the last
record's `hashAfter` equals the returned reply.

Fix: `src/services/conversations/conversation-stage.ts` now accumulates through
a small private `RewriteChain` seeded with the raw `modelReply`, so each layer's
`before` is literally the text that left the previous layer. The normalisation
performed by `splitSentences` is therefore absorbed into the first record
instead of vanishing. GREEN: `# tests 28 / # pass 28 / # fail 0`.

### Deviation 3's caveat — one shared helper

`buildRewriteRecord(layer, before: string, after: string, detail?)` now lives in
`src/lib/turn-trace.ts` (planner decision P-3) and is the only constructor of
records. The two private copies in `src/ai/agent.ts` and
`conversation-stage.ts` are gone, and the string/string-array asymmetry that
hosted B-1 is gone with them. Batch C's L5, L10 and L11 use the same helper, so
no third variant was added.

### Registering `src/tests/turn-trace-adversarial.test.ts`

Added to the `test:unit` list in `package.json`; assertions untouched. Suite
after the B-1 fix and the registration: `ℹ tests 238 / ℹ pass 238 / ℹ fail 0`
(228 + the tester's 9 + my 1 B-1 regression test). Notably the tester's
288-case golden digest over `composeStageReply` outputs *and* layer sequences
still passes, which is the evidence that the chaining fix changed no reply text
and no layer order.

## Batch C — assemble and emit (steps 7–8)

### Planner decision P-1 — `guardrailLayer`

RED first, in `src/tests/agent-model-config.test.ts` (`o erro de guardrail diz
qual camada lançou`, with the real-client trap installed **before** the run,
per the coordinator's warning):

```
not ok 6 - o erro de guardrail diz qual camada lançou
  expected: 'L4_safety_assertion'
# tests 6 / pass 5 / fail 1
```

Fix: `TurnRewritesCarrier` in `src/ai/agent.ts` gained
`turnGuardrailLayer?: RewriteLayer`, and the two catch sites attach their own id
(`L2_evidence_invalid_id`, `L4_safety_assertion`). The throw itself is
unchanged — same error, same message, same rejection. `TurnTrace` gained
`guardrailLayer: RewriteLayer | null`. GREEN: `# tests 6 / # pass 6 / # fail 0`.

### Planner decision P-2 — a missing `rewrites` is never `[]`

Route chosen: keep the six `metadata` fields optional (so the three DB test
files that hand-build `GenerateMarianaReplyResult` stay untouched) and make the
*sink* explicit. `TurnTrace` now has `rewrites: RewriteRecord[] | null` plus
`rewritesReported: boolean`, and `pureBackendText: boolean | null` — because
with the layers unknown that claim is undecidable, and `false` would be a
guess. The DB test `um produtor que não reporta rewrites nunca vira lista
vazia` pins all three (`rewritesReported === false`, `rewrites === null`,
`pureBackendText === null`).

Three more fields were widened to `| null` for the failure path, so the line
never invents data it does not have: `commercialAccessLevel`, `rawReplyHash`
/ `rawReplyLength`, `sentReplyHash` / `sentReplyLength`. On a guardrail throw
nothing was sent, and the trace now says so instead of reporting a hash of `""`.

### Step 7 — `generateMarianaResponse` assembles and logs the turn

Files: `src/services/conversations/generateMarianaResponse.ts`,
`src/ai/agent.ts` (P-1), `src/lib/turn-trace.ts` (P-1/P-2 fields),
`src/tests/services/generate-mariana-response-authorization.test.ts`,
`src/tests/services/generate-mariana-response.test.ts`.

L5/L10 (unit, RED first):

```
not ok 9 - persistAuthorizedAssistantReply registra L5 e L10
  error: "Cannot read properties of undefined (reading 'map')"
# tests 9 / pass 8 / fail 1
→ GREEN # tests 9 / # pass 9 / # fail 0
```

`persistAuthorizedAssistantReply` now returns `rewrites`, carrying
`L5_request_consultant_override` when the handoff replaces the text and
`L10_unauthorized_scheduling` when an unauthorised scheduling promise falls
back — and an empty list when it changed nothing.

Full turn (DB suite, RED first — 3 new tests):

```
not ok 8 - um turno emite exatamente uma linha mariana_turn com as camadas que alteraram o texto
not ok 9 - uma exceção de guardrail ainda é registrada como guardrail_throw
not ok 10 - um produtor que não reporta rewrites nunca vira lista vazia
# tests 10 / pass 7 / fail 3
→ GREEN # tests 10 / # pass 10 / # fail 0
```

Wiring: `traceTurnId?: string` param; the compose call uses
`composeStageReplyWithTrace` (or records L5 when `request_consultant`
short-circuits it); the transaction returns the stage + authorization records
plus `postTurnStage` and `questionKey`; L11 is recorded inline where the slot
offer replaces the text; a private `emitTurnTrace` builds the line and
`logTurnTrace` is called exactly once before the return. The model call is
wrapped so that an error carrying `turnGuardrailLayer` emits one
`guardrail_throw` line and is **rethrown unchanged** — an error without that
marker is left entirely alone, since model failure is Batch D.

One fixture correction, same class as step 4's: my synthetic turnIds
(`…-555555555555`) contain a 12-digit run and tripped my own "no 11-digit
sequence" privacy assertion. Replaced with hex-mixed UUIDs so the assertion
tests the line, not the fixture.

### Step 8 — thread `turnId` from the task

Files: `src/services/conversations/autonomous-task-handlers.ts` (one line:
`traceTurnId: task.id`); test in
`src/tests/reliability/inbound-batch-claim.test.ts` (which already mocks the
Gemini client).

RED — the trace used the conversation id:

```
not ok 2 - o rastro do turno usa o id da task âncora
  expected: 'adb50a90-a26c-4964-80db-80188090d9ad'   (task id)
  actual:   '05f8c327-9725-4539-9912-19221c5908c2'   (conversation id)
# tests 2 / pass 1 / fail 1
→ GREEN # tests 2 / # pass 2 / # fail 0
```

### Batch verification

```
npm run test:unit   →  ℹ tests 240 / ℹ pass 240 / ℹ fail 0
npx tsc --noEmit    →  no output, exit 0
npm run test:db     →  [setup-test-db] target localhost:5432/mariana_pkg_a_trace_test
                       ℹ tests 437 / ℹ pass 437 / ℹ fail 0
npx ultracite check <the 11 changed files>  →  Checked 11 files. No fixes applied.
```

**About the DB run.** Question 2 of the plan — which local container is the
disposable target — is still unresolved, so I reset *neither* existing
database. I created a brand-new `mariana_pkg_a_trace_test` on the container
documented in `CLAUDE.md:24` (`mariana:mariana@localhost:5432`, host and
database printed by the setup script, password never printed) and pointed
`TEST_DATABASE_URL` at it, with `RELIABILITY_WORKERS_ENABLED=false`. Dropping
the public schema of a database created seconds earlier cannot destroy
anything. Neon was never contacted; `mariana` and the other `mariana_*_test`
databases were not touched; no migration command was run. Davi can drop
`mariana_pkg_a_trace_test` at will.

### Deviations and known gaps (Batch C)

1. **`TurnTrace` grew three nullable widenings** beyond P-1/P-2
   (`commercialAccessLevel`, the two `rawReply*`, the two `sentReply*`). The
   Design table types them as always-present. Reporting `null` is the honest
   alternative to inventing a value on the guardrail path, and the privacy
   property is untouched (still no field whose type admits free text).
2. **`pureBackendText` and `rawReplyHash` use `response.result.reply` as "the
   raw reply"** when the producer did not report a hash. At this layer that is
   the text the backend actually received; the true pre-L1 text never leaves
   `agent.ts` by design.
3. **No record is emitted for pure normalisation.** If no layer fires but
   `splitSentences` re-joins differently, `rewrites` is `[]` while
   `sentReplyHash !== rawReplyHash`. Closing it would need a thirteenth layer
   id, which would contradict the fixed twelve-layer inventory, so the two
   hashes are left to speak for themselves.
4. **`actionBlockedReason` is always `null`** — `ExecuteNextActionResult` has
   no blocked branch today, so there is nothing to report. The field is kept
   for when one exists.
5. **`executedAction` is `nextActionResult.action`** (the Design says
   "`.action` / `.status`"); `status` is not in the line.

Step 7's acceptance criterion keeps its marker verbatim — `redação de
R-REL-07 não disponível — critério derivado do brief, pendente de
confirmação`. No spec wording was invented.

## Batch C — defect fixes (from `test-report-batch-C.md`)

DB target for every run below: `localhost:5433/mariana_impl_batch_d`, user
`postgres`, on the `mariana-test-pg` container Davi chose (password never
printed). I created that database; `mariana_test` and the tester's
`mariana_tester_batch_c` were not touched, and the `5432` container was not
used again. `.env`/Neon untouched, `RELIABILITY_WORKERS_ENABLED=false`.

### C-1 / P-4 — a turn that throws anywhere now emits its line

RED first, with the tester's shape (calendar failure after a successful model
call), in `src/tests/services/generate-mariana-response.test.ts`:

```
not ok 11 - um turno que falha depois da chamada ao modelo ainda emite uma linha
  expected: 1
  actual: 0
# tests 11 / pass 10 / fail 1
```

That is the tester's `PROBE_LINES=0`, reproduced as a committed test. Fix: the
whole turn is inside the `try` now, with a `traceEmitted` flag so the guardrail
path cannot double-emit, and a new `TurnOutcome` value `turn_error`
(`guardrailLayer` stays `null`). The catch re-throws the error untouched, so
the task fails exactly as before. A `turnResponse` capture means the line still
carries the model's own metadata when the model had already answered.
GREEN: `# tests 15 / # pass 15 / # fail 0` (including the tester's four
integration tests, unchanged).

Also added: a `model_error` classification, red first
(`expected: 'model_error' / actual: 'turn_error'`), so a `ModelUnavailableError`
is not reported as a generic turn error. That keeps one line per turn: the
trace is emitted where the context lives, and step 11's handler only adds its
`console.error`.

### C-4 / P-5 — `actionBlockedReason` carries the real reason

RED first, unit (`src/tests/execute-next-action.test.ts`) and DB:

```
not ok 21 - a ação rebaixada carrega o motivo do bloqueio
  expected: 'no_current_scheduling_intent'
# tests 21 / pass 20 / fail 1
```

`ExecuteNextActionResult`'s downgraded variant gained an optional
`blockedReason`, set in the blocked branches, and the trace reports it through
a `blockedReasonOf` narrowing helper. **There are four blocked branches, not
three** (`agent_action_blocked` at the post-edit lines 252, 268, 298, 314 — the
report cited 245/260/289 and missed the fourth); all four are patched, which is
what P-5 intends. No branch changed which action it downgrades to, and nothing
around `acceptedPendingOffer` was touched, so the pending-offer invariant is
intact.

Consequence I had to handle: seven pre-existing `assert.deepEqual(result, …)`
assertions in `execute-next-action.test.ts` broke, because the result object
grew a property. Control flow did not change, so I updated those seven
expectations to include the reason the branch now reports, and nothing else.

### C-2 and C-3 — the line stops inventing data

Both were implemented alongside C-1, so I captured their red by backing the
one-line fixes out again:

```
not ok 11 - um turno que falha depois da chamada ao modelo ainda emite uma linha
  expected: ~        actual: 'test-model'      (modelVersionReturned)
not ok 12 - o rastro não inventa latência, versão de modelo nem hash cru
  expected: ~        actual: 'test-model'
not ok 13 - um guardrail não reporta latência medida
  expected: ~        actual: 0                 (latencyMs)
# tests 13 / pass 10 / fail 3
```

C-2: `latencyMs` is `null` when nothing was measured (`TurnTrace.latencyMs` is
now `number | null`), and `modelVersionReturned` comes from a new
`metadata.modelVersionReturned` that holds `response.modelVersion ?? null` —
so a field named "returned" can no longer hold the configured name.
C-3: with `rewritesReported: false`, `rawReplyHash` and `rawReplyLength` are
`null` instead of a hash of the post-L1/L3 text. GREEN after restoring:
`# tests 17 / # pass 17 / # fail 0`.

### Declared deviation

`generateMarianaResponse` crossed biome's cognitive-complexity limit (23, then
21 after I extracted `emitFailureTrace`). The function was already at the limit
of 20 before P-4; splitting it is a behaviour refactor outside this step. I
added a file-scoped `biome-ignore-all` for that one rule **with the reason
written in it**, consistent with the four suppressions the file already
carries. In `src/ai/agent.ts` the same limit was crossed by one point and I
fixed it properly instead, by extracting a pure `parseModelJson` helper.

## Batch D — honest model failure (steps 9–11)

### Step 9 — `ModelUnavailableError`

Files: new `src/ai/model-errors.ts`; `src/ai/agent.ts`; new unit file
`src/tests/model-failure-notice.test.ts` (registered in `test:unit`, CODEMAP
row added). The real client is trapped in every test **before** the first red
run, as instructed — no request left the machine this time.

RED: `Error: Cannot find module '../ai/model-errors'`.
GREEN: `# tests 3 / # pass 3 / # fail 0` — transport (the N6 404, `cause`
preserved), `empty_response`, `invalid_json`, and the scope guard proving a
guardrail error is **not** wrapped.

The error carries `kind` in its options argument (`new ModelUnavailableError(
message, { cause, kind })`) because biome's `useErrorCause` only recognises
`cause` in the second argument; passing it third tripped the rule.

### Step 10 — the notice text

File: new `src/services/conversations/model-failure-notice.ts`.
RED: `Error: Cannot find module '…/model-failure-notice'`.
GREEN: `# tests 6 / # pass 6 / # fail 0`.

The text is pinned by an exact-text assertion, so any future edit needs a fresh
approval from Davi:

> Desculpe, tive uma falha técnica aqui e não consegui processar sua mensagem agora. Pode me enviar de novo em alguns instantes?

128 characters (≤ 160, one bubble). Two invariant tests back it:
`detectPendingOffer(MODEL_FAILURE_NOTICE) === null`, so it cannot arm the
pending-offer marker; and `persistAuthorizedAssistantReply` leaves it untouched
with `rewrites: []`, so it carries no scheduling promise.

### Step 11 — the handler completes instead of failing

Files: `src/services/conversations/autonomous-task-handlers.ts`; new DB test
`src/tests/reliability/model-failure.test.ts` (DB glob, no registration).

RED (only the Gemini client is mocked; the claim, handlers and outbox are real):

```
not ok 1 - falha do modelo enfileira o aviso e conclui a task
  expected: 1   actual: 0        (nenhuma linha de outbox)
not ok 2 - o aviso de falha nunca é enviado duas vezes
  error: 'Gemini request failed before producing a response'
# tests 3 / pass 1 / fail 2
```

Test 3 (a non-model failure must still fail the task) passed from the start, by
construction — it is the scope guard against swallowing every error.

Fix: a `sendModelFailureNotice` helper that persists the assistant message,
enqueues with **the `runKey` that already exists**, marks the messages and the
event processed exactly as the success path does, logs
`{ event: "mariana_model_failure", kind, model, conversationId, leadId }` and
returns `{ modelFailureNotice: true, outboundQueued: true }`. Only
`ModelUnavailableError` is caught; anything else is re-thrown unchanged.
GREEN: `# tests 3 / # pass 3 / # fail 0`.

Invariants, proved in the dedup test rather than assumed. My first expectation
was wrong and the code was right: on re-execution the handler returns
`{ skipped: true }`, because the inbound messages are already
`processedAt`-marked and the batch comes back empty — it never reaches the
`runKey` check. So I assert both layers: the skip, and then, after clearing
`processedAt` to simulate a retry where the marking had failed, that the reused
`runKey` returns `{ deduplicated: true }` with still exactly one outbox row. No
second idempotency key exists anywhere in the path.

### Deviation from Design item 3

Design item 3 step 4 puts `logTurnTrace({ outcome: "model_error", … })` in the
handler. I emit it in `generateMarianaResponse` instead, where the stage,
metadata and rewrites actually live, and leave only the `console.error` in the
handler. The handler has none of the trace context, and emitting in both places
would break the "exactly one `mariana_turn` line per turn" property the tester
verified on every outcome. Same data, honest source.

### Batch verification

```
npm run test:unit   →  ℹ tests 247 / ℹ pass 247 / ℹ fail 0
npm run test:db     →  [setup-test-db] target localhost:5433/mariana_impl_batch_d
                       ℹ tests 455 / ℹ pass 455 / ℹ fail 0
npx tsc --noEmit    →  no output, exit 0
npx ultracite check <the 11 changed files>  →  Checked 11 files. No fixes applied.
```

Step 11's acceptance criterion keeps its marker verbatim — `redação de S-17
não disponível — critério derivado do brief, pendente de confirmação`. No spec
wording was invented. Batch E was not started.
