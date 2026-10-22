# Test report — Package A, Batch A (steps 1–3)

Tester run, 2026-10-22, independent of the implementer's own account. No database was used (no step in the batch touches it), no Gemini or Google API call was made, `.env` was not touched, and no version-control write command was run. `RELIABILITY_WORKERS_ENABLED=false` in every run.

Approval gate: `docs/work/2026-10-22-pkg-A/plan.md:1` reads `Status: APPROVED by Davi — 2026-10-22.` — gate satisfied. HEAD (`4a0c522`, author Davi) contains only `plan.md`, `explicacao.md` and `.claude/hooks/block-git.sh`; **no Batch A product code is in version control**, as required.

## Verdict

| Step | Verdict |
|---|---|
| Step 1 — `env.ts`, the four Gemini variables | **PASS** (one low-severity hole, D-2) |
| Step 2 — `agent.ts` uses the configuration | **PASS on product code**, with one test defect to fix (D-1) |
| Step 3 — `.env.example` documents the variables | **PASS** |

Overall: **PASS with 2 defects, neither blocking Batch B.** D-1 (medium) is in test code and will turn the unit suite red the first time the owner uses the feature as designed. D-2 (low) is a single-value coercion hole.

## Owner decisions — checked in the code, not only in a test

| Decision | Code location | Result |
|---|---|---|
| `GEMINI_MODEL` default `gemini-3.5-flash-lite` | `src/env.ts` `.default("gemini-3.5-flash-lite")` | PASS |
| `GEMINI_TEMPERATURE` default `0.3` | `src/env.ts` `z.coerce.number().min(0).max(2).default(0.3)` | PASS |
| `GEMINI_THINKING_LEVEL` default `LOW` | `src/env.ts` `z.enum([...]).default("LOW")` | PASS |
| `GEMINI_MAX_OUTPUT_TOKENS` default `1024` | `src/env.ts` `.int().min(128).max(8192).default(1024)` | PASS |

All four reach the SDK call: `buildModelRequestConfig` (`src/ai/agent.ts:52-73`) sets `temperature`, `maxOutputTokens`, `thinkingConfig.thinkingLevel`, and the call site passes `model: resolveModelName()`. Verified end to end in a child process (probe A below), not only through the module defaults.

## Criterion → test → result

| Plan criterion (steps 1–3) | Test(s) | Result |
|---|---|---|
| `parseEnv` applies the four Gemini defaults | `src/tests/env.test.ts` "parseEnv aplica os defaults do Gemini"; mine "os defaults do dono são os do envSchema…" | PASS |
| A model name outside the format is refused | `env.test.ts` "recusa um nome de modelo fora do formato"; mine, 8 invalid model values | PASS |
| Invalid temperature / thinking level / token cap are refused | `env.test.ts` "recusa temperatura e nível de raciocínio inválidos"; mine, 26 invalid values total | PASS |
| An invalid value fails validation, never falls back silently | mine "um valor inválido do Gemini falha a validação, nunca cai no default"; probe B | PASS except D-2 |
| Config carries model, temperature, thinking level, output cap; `responseMimeType`/`responseJsonSchema` unchanged | `src/tests/agent-model-config.test.ts` test 1; mine "a configuração espelha o ambiente ativo…" | PASS |
| The model comes from the environment, not a constant | `agent-model-config.test.ts` test 2 (weak, see D-1/dev. 1); mine "nenhum nome de modelo literal volta ao agent.ts, de nenhuma forma"; probe A | PASS |
| `.env.example` documents ≥ 5 `GEMINI_` names matching `envSchema` | mine ".env.example documenta as quatro variáveis com os defaults aprovados" (step 3 had no automated test) | PASS |
| No test opens a network or database connection | probe C (whole batch under a net/dns/http/fetch trap); mine "montar a configuração não abre conexão de rede nem de banco" | PASS |

## Suites I ran myself

```
npm run test:unit        →  ℹ tests 208  ℹ pass 208  ℹ fail 0      (confirms the implementer's 208/0)
npx tsc --noEmit         →  exit 0, no output                      (confirms the implementer's exit 0)
npm run build            →  CJS dist/server.js 1.39 MB — Build success
git diff --check         →  exit 0
npx ultracite check src/env.ts src/ai/agent.ts src/tests/env.test.ts src/tests/agent-model-config.test.ts
                         →  Checked 4 files. No fixes applied.     (implementer's files are lint-clean)
npx ultracite check src/tests/gemini-model-config-adversarial.test.ts
                         →  Checked 1 file. No fixes applied.      (after I fixed my own 10 lint errors)
```

`npm run test:db` was **not** run: Batch A adds no DB code and no migration, so a DB run would prove nothing. Nothing was started, written or dropped in any container; Neon was never contacted.

## The three declared deviations, judged

**1. New one-line pure `resolveModelName()` — ACCEPTED, sound and necessary.**
`GenerateContentConfig` (`node_modules/@google/genai/dist/genai.d.ts:6121-6290`) has `temperature`, `maxOutputTokens` and `thinkingConfig` but **no `model` field** — the model is a sibling of `config` in the `generateContent` argument. So the planned `buildModelRequestConfig` genuinely could not expose the resolved model, and a one-line pure accessor is the minimal seam. It weakens nothing: the three former `MODEL` references all go through it, and `grep -n MODEL src/ai/agent.ts` now returns only `return env.GEMINI_MODEL;`.
Caveat: the guard the implementer paired with it is weak. `HARD_CODED_MODEL = /const\s+MODEL\s*=\s*["'`]gemini-/` would **not** catch a regression written as `return "gemini-3.5-flash-lite";` inside `resolveModelName`, and the companion assertion `resolveModelName() === "gemini-3.5-flash-lite"` would still pass in that case. I added a stronger guard (no `["'`]gemini-[0-9]` literal anywhere in `agent.ts`, plus `env.GEMINI_*` reads present) and a child-process probe that proves the value is truly read from the environment.

**2. `ThinkingLevel[env.GEMINI_THINKING_LEVEL]` — ACCEPTED, necessary, and the `"LOW"` assertion still means what it says.**
`thinkingLevel?: ThinkingLevel` is a string enum, not a string union, so the raw env string is rejected by `tsc` exactly as reported. Indexing the enum by key is preferable to an `as ThinkingLevel` cast, because it would stop compiling if the SDK renamed a member. The enum values are the identical strings (`genai.d.ts:15902-15922`: `MINIMAL = "MINIMAL"`, `LOW = "LOW"`, `MEDIUM = "MEDIUM"`, `HIGH = "HIGH"`), so `ThinkingLevel["LOW"] === "LOW"` and the wire value is `"LOW"`. I pinned that assumption in its own test, so an SDK upgrade that changes a value breaks a test instead of silently changing the request. `thinkingBudget` is correctly never set (asserted).

**3. Registering the test in `package.json` rather than `docs/CODEMAP.md` — ACCEPTED, the claim is true.**
`docs/CODEMAP.md` keeps no per-file unit-test list; it points at `package.json`. And the file really does run inside the suite: `npm run test:unit | grep -c "o modelo vem do ambiente"` → `1`.
Undeclared but harmless fourth deviation: the plan said "four **commented** entries" in `.env.example`; the implementer shipped four commented *explanations* with uncommented assignments. That matches the file's existing style (`GEMINI_API_KEY` is uncommented) and does not weaken anything.

## Defects

### D-1 (medium, implementer fixes) — `agent-model-config.test.ts` goes red as soon as the owner tunes `.env`

The test asserts the literal default values against the **real** process environment (`src/env.ts:end` does `parseEnv(process.env)` after `import "dotenv/config"`). `src/tests/support/fake-external-env.ts` pins only `GEMINI_API_KEY`, so nothing isolates the suite from `.env`. The plan's whole selling point is "`MEDIUM`/`HIGH` are left for Davi to try in `.env` without a deploy" (plan.md:134) — doing that breaks the suite.

```
GEMINI_THINKING_LEVEL=MEDIUM GEMINI_TEMPERATURE=0.7 npx tsx --import ./src/tests/support/unit-test-preload.ts \
  --test src/tests/agent-model-config.test.ts
  code: 'ERR_ASSERTION', actual: 0.7, expected: 0.3, operator: 'strictEqual'
```

Expected: the suite passes on any valid configuration. Actual: it fails. Suspected cause: default-pinning assertions placed in the module-level-env test instead of in `env.test.ts`, which uses an explicit `VALID_SOURCE` and is immune. Suggested fix: in `agent-model-config.test.ts` assert against `env.GEMINI_TEMPERATURE` / `env.GEMINI_MAX_OUTPUT_TOKENS` / `ThinkingLevel[env.GEMINI_THINKING_LEVEL]` / `env.GEMINI_MODEL`; the owner-decision defaults are already pinned (twice) in `env.test.ts` and in my file against an explicit source. No product change needed.

### D-2 (low, implementer fixes) — a whitespace-only `GEMINI_TEMPERATURE` coerces to `0` instead of failing

```
GEMINI_TEMPERATURE="   " … probe
{"model":"gemini-3.5-flash-lite","temperature":0,"maxOutputTokens":1024,"thinkingLevel":"LOW"}
```

`source.X || undefined` keeps `"   "` (truthy), then `z.coerce.number()` turns it into `Number("   ") === 0`, which passes `min(0)`. So a typo produces temperature `0`, which is neither the configured value nor the approved default `0.3`, and nothing is logged. The other three variables are safe (`"   "` → `0` fails `min(128)`; the enum and the regex reject it). Cheap fix: `source.GEMINI_TEMPERATURE?.trim() || undefined`, or the same `.trim()` for all four. The identical hole exists in the pre-existing `WHATSAPP_SEND_TIMEOUT_MS` pattern, so this is an inherited habit, not a new invention.

## My adversarial tests

New file: `src/tests/gemini-model-config-adversarial.test.ts` — 8 tests, all passing, no network, no DB.

1. `um valor inválido do Gemini falha a validação, nunca cai no default` — 26 invalid values across the four variables, each asserted to throw **naming the variable**: `gpt-4o`, `gemini-3.6-flahs-lite` (misspelling), `gemini-flash-lite`, `gemini-3.5-ultra`, uppercase, leading/trailing space, `models/…` prefix; `-0.1`, `2.1`, `quente`, `0,3`, `NaN`; `ULTRA`, `low`, `Low`, `LOW `, `THINKING_LEVEL_UNSPECIFIED`, `1`; `10`, `127`, `8193`, `1024.5`, `-1024`, `muitos`.
2. `um valor válido fora do default é respeitado…` — `gemini-2.5-pro` / `1.7` / `HIGH` / `4096` are honoured, so the defaults never override a real setting.
3. `os defaults do dono são os do envSchema…` — the four owner decisions, against an explicit source (immune to `.env`).
4. `o enum ThinkingLevel do SDK tem exatamente os mesmos textos do env` — pins deviation 2.
5. `a configuração espelha o ambiente ativo, não números literais` — config fields equal `env.*` (not literals), and `thinkingBudget` is `undefined` (Gemini 3.5 rejects it).
6. `nenhum nome de modelo literal volta ao agent.ts, de nenhuma forma` — no `gemini-<digit>` string literal in `src/ai/agent.ts`, and all four `env.GEMINI_*` reads present. Catches the regression class the implementer's `const MODEL =` regex misses.
7. `montar a configuração não abre conexão de rede nem de banco` — `net.Socket.prototype.connect` and `fetch` trapped; zero attempts.
8. `.env.example documenta as quatro variáveis com os defaults aprovados` — the four exact default lines, and the set of `GEMINI_` names in `.env.example` equals the set in `envSchema`. This is step 3's missing automated proof.

Out-of-band probes (child processes, not committed):
- **A — the model really comes from the environment**: `GEMINI_MODEL=gemini-2.5-pro GEMINI_TEMPERATURE=1.7 GEMINI_THINKING_LEVEL=HIGH GEMINI_MAX_OUTPUT_TOKENS=4096` → `{"model":"gemini-2.5-pro","temperature":1.7,"maxOutputTokens":4096,"thinkingLevel":"HIGH"}`.
- **B — an invalid value stops boot**: `GEMINI_MODEL=gemini-3.6-flahs-lite` → `Error: Invalid environment configuration:\n  - GEMINI_MODEL: GEMINI_MODEL deve seguir o formato gemini-<versão>-<flash|flash-lite|pro>`. No silent fallback.
- **C — no network, no DB, including at import time**: both batch-A test files re-run with `net.Socket.prototype.connect`, `net.connect`, `dns.lookup`, `http.request`, `https.request` and `fetch` all throwing → `13 pass`.

**Action needed from the implementer**: add `src/tests/gemini-model-config-adversarial.test.ts` to the `test:unit` list in `package.json`. As tester I may not edit `package.json`. Until then run it with
`npx tsx --import ./src/tests/support/unit-test-preload.ts --test src/tests/gemini-model-config-adversarial.test.ts`.
(It is already picked up by the `src/tests/**/*.test.ts` glob of `npm test` / `npm run test:db`, where it is harmless — it opens nothing.)

## Invariants checked (`CLAUDE.md`)

| Invariant | How it was checked | Result |
|---|---|---|
| Never write to Neon | the diff contains no `.env`, no `drizzle/`, no migration command; no DB run happened | holds |
| No real Gemini/Google/WhatsApp call | probe C traps all network primitives; `ai` is a module-level singleton that issues no request at import | holds |
| `RELIABILITY_WORKERS_ENABLED=false` | set in every run; also pinned by `unit-test-preload.ts` | holds |
| The AI is never the authority on IDs, availability or authorization | only sampling parameters changed; no decision-path file is in the diff | holds |
| Duplicate inbound events / outbound state machine / `selectedSlotId` | untouched by Batch A — no file in those paths is in the diff | holds |
| Migration freeze | no file under `drizzle/`, no `db:*` script run | holds |
| Conversation behaviour unchanged | full unit suite unchanged at 208/208, including the stage, authorization, pending-offer and compliance suites | holds |

Files in the diff vs. files the plan listed for steps 1–3: `src/env.ts`, `src/tests/env.test.ts`, `src/ai/agent.ts`, `src/tests/agent-model-config.test.ts` (new), `package.json`, `docs/CODEMAP.md`, `.env.example` — **exactly the planned set**. The two extra modified files, `docs/work/2026-10-22-pkg-A/plan.md` and `.../explicacao.md`, are the planner's approval edits (the `Status: APPROVED` header and the re-verified blocker), not implementer work; `progress.md` is new and expected. Nothing outside the plan was touched.

## Risks not covered by tests

1. **No test can prove the live API accepts this config.** That `gemini-3.5-flash-lite` honours `thinkingLevel: "LOW"` and `maxOutputTokens: 1024`, and that a 3.5 model rejects `thinkingBudget`, rests on the SDK typings and the audit — not on a call. First real traffic is the first proof. Deliberate: real API calls are forbidden here.
2. **The regex is a partial guard, as the plan admits.** `gemini-3.6-flash-lite` — the N6 shape — still matches. Conversely a legitimate off-pattern name (`gemini-flash-latest`, `gemini-exp-1206`) would now **stop boot**. This is a planner-owned trade-off, not an implementer error; worth a line in A2.
3. **Still no request deadline / `abortSignal`** on the Gemini call. A hung call remains a lease expiry and a silent client until Batch D/E.
4. **Temperature `0.3` and thinking level `LOW` are unvalidated against conversation quality.** That is Package A2's simulator comparison, which I did not run (not authorised in this task).
5. **`env` is now imported by `src/ai/agent.ts`.** Any module that imports the agent now triggers full env validation at import time. Harmless today (`./client` already imported `env`), but it does mean a bad `GEMINI_*` value fails the process early — which is the intent, just worth knowing.
6. **Final acceptance against the spec remains open**: the wording of `R-REL-07` / `S-17` is still unavailable, so step 2's criterion stays "derived from Davi's brief". I could not verify it against a spec that does not exist in the repository.

## Manual WhatsApp checklist for the owner

Batch A changes no conversation logic — only sampling. Two things are worth one real conversation before Batch B, with the app running against the real number:

1. Send `oi` → expect Mariana's normal greeting, within the usual delay. What this proves: the new `temperature` / `maxOutputTokens` / `thinkingConfig` fields did not make the request invalid (an invalid field would surface as a model failure, which is still silent until Batch D).
2. Send a long question such as `me explica como funciona o consórcio e quais as formas de contemplação` → expect a complete reply, not a sentence cut mid-word. What this proves: `maxOutputTokens: 1024` is not truncating the JSON. A truncated or missing reply here means the cap is too low — raise `GEMINI_MAX_OUTPUT_TOKENS` in `.env` and retest.
3. Then try `GEMINI_THINKING_LEVEL=MEDIUM` in `.env` and restart, and send `qual o valor da carta de 300 mil?` → expect the same compliant answer, slightly slower. Note: **doing this currently breaks `npm run test:unit`** until defect D-1 is fixed.
4. Negative check, no message to send: put a deliberate typo in `.env` (`GEMINI_MODEL=gemini-3.5-flahs-lite`) and start the app → it must refuse to boot with `Invalid environment configuration: - GEMINI_MODEL …`, never start with a fallback. Remove the typo afterwards.
