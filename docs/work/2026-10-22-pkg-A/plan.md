Status: DRAFT — awaiting Davi's approval

# Package A — "Enxergar e proteger" (turn trace, model config, honest model failure, test safety)

Task id: `2026-10-22-pkg-A` · Roadmap row **A** (`docs/specs/ROADMAP-2026-10-22.md:24`) · Audit **WP-0** (`docs/work/2026-10-22-audit/audit-report.md:658`) · Findings **F-15**, **F-06**, parts of **F-20** · Snapshot **N6**.

## Summary

Three observability/configuration changes plus one safety change, with **no conversation-behaviour change**: (1) one structured log line per turn that says what the model produced and which of the eleven rewriting layers altered it; (2) model id, temperature, thinking level and output cap move to `.env` with validated defaults; (3) a Gemini failure after retries sends the client a short honest message instead of leaving him silent; (4) the four cheap test-isolation holes from the coverage report are closed, starting with the unused `vitest` dependency and `setup-test-db.ts`.

Everything here is schema-free. The migration freeze (`CLAUDE.md`) is respected: no step needs a migration, so no step is BLOCKED on it.

## Blocker recorded before anything else

`docs/specs/MARIANA_BEHAVIOR_SPEC.md` **does not exist**. The audit found it at the repo **root**, untracked, v1.0 (`audit-report.md:38-42`, finding F-01); it is no longer there (`ls MARIANA_BEHAVIOR_SPEC.md` → no such file) and, being untracked, git cannot restore it. The rule ids `R-REL-07` and `S-17` named by Davi's brief exist nowhere in the repository except as bare ids in the roadmap table, so their wording is lost.

Consequence for this plan: every acceptance criterion that would quote `R-REL-07` or `S-17` is written from Davi's brief and marked
**"redação de R-REL-07/S-17 não disponível — critério derivado do brief, pendente de confirmação"**.
No spec prose is invented, and no spec file is written by me. First question in `explicacao.md`.

## Root causes

| # | Claim | Status | Evidence |
|---|---|---|---|
| RC-1 | Nothing in the decision path logs anything about the model turn, so "did she reason badly or did we delete her reasoning?" is unanswerable | **confirmed** | `src/ai/agent.ts:250` parses `rawText` and drops it; `agent.ts:284-290` returns `metadata {latencyMs, model, usage}`; the only caller, `generateMarianaResponse.ts:700`, returns it upward and `autonomous-task-handlers.ts:190-196` ignores it. No `console.*` and no logger import in `src/ai/` or `generateMarianaResponse.ts`. Audit §2.3.3 |
| RC-2 | Eleven layers can rewrite or replace the reply and none of them is observable | **confirmed** | Enumerated with file:line in audit §2.3 (L0 `agent.ts:198-213` … L11 `generateMarianaResponse.ts:654`). `composeStageReply` (`conversation-stage.ts:381-425`) returns a bare `string`, so L6–L9 leave no trace at all |
| RC-3 | The model is called with no temperature, no thinking configuration and no output cap, at the cheapest tier, from a hard-coded constant | **confirmed** | `src/ai/agent.ts:36` `const MODEL = "gemini-3.5-flash-lite"`; `agent.ts:240-248` `config` has only `responseJsonSchema`, `responseMimeType`, `systemInstruction`. Audit §2.1 |
| RC-4 | A wrong model id silences clients: the id is a source constant, 404 is (correctly) not retried, and a task failure sends nothing | **confirmed** | `src/ai/client.ts:4-11` retries only 408/429/500/502/503/504; `agent.ts:36` constant; `autonomous-task-handlers.ts:190` has no try/catch around `generateMarianaResponse`, so the throw propagates to the executor, which retries and then marks the task `failed` (`autonomous-task-executor.ts:200-243`) with no outbound message. N6: 19 `process_inbound_message` failures on Oct 13–14 (`docs/NEON_SNAPSHOT_2026-10-22.md`, audit §2.1.1) |
| RC-5 | `vitest ^5.0.4` is an unused runtime dependency that would run the whole DB suite with no preload, no guard and real credentials | **confirmed** | `package.json:33`, no `vitest.config.*`/`vite.config.*`, no script uses it, `grep -rn vitest` outside `node_modules` hits only that line (verified by the caller and by coverage report §4.3 hole 1) |
| RC-6 | `setup-test-db.ts` keeps `DATABASE_URL` = Neon in a process whose next statement is `DROP SCHEMA public CASCADE` | **confirmed** | `src/tests/support/setup-test-db.ts:7` `import "dotenv/config"`; line 19 destructures `resolveTestDatabaseEnv(process.env)` into a local and never assigns `process.env`; line 24 opens the pool on the (correct) test URL, line 26 drops the schema, line 39 passes `env: process.env` to `drizzle-kit push`. Safe today only because `drizzle.test.config.ts:11` re-resolves the URL itself. Coverage report §4.3 hole 4 |
| RC-7 | The guard is a one-vendor hostname denylist, not a "disposable local database" allowlist | **confirmed** | `src/tests/support/test-database-guard.ts:53` `hostname.includes("neon.tech")`. Coverage report §4.3 hole 3 |
| RC-8 | `unit-test-preload.ts` is correct only because dotenv does not override | **confirmed** | `unit-test-preload.ts` has no `import "dotenv/config"` (unlike `db-test-preload.ts:5`); correctness rests on dotenv's default `override: false`. Coverage report §4.3 hole 5 |
| — | "A startup check that the configured model exists would prevent N6" | **unclear, moved out of scope** | Verifying existence requires a live `models.get`/`models.list` call. I may not call the API, and a boot-time network call is a new failure mode. Env-level *shape* validation (step 1) catches typos; item 3 makes the remaining case non-silent. A live probe is listed in "Out of scope" with a question for Davi |

## Design

### Item 1 — turn trace

New module `src/lib/turn-trace.ts`:

- `export type RewriteRecord = { layer: RewriteLayer; lengthBefore: number; lengthAfter: number; hashBefore: string; hashAfter: string; detail?: Record<string, number | string> }`
- `export type RewriteLayer = "L0_level3_short_circuit" | "L1_identity_sanitizer" | "L2_evidence_invalid_id" | "L3_evidence_handoff" | "L4_safety_assertion" | "L5_request_consultant_override" | "L6_dropped_questions" | "L7_dropped_greeting" | "L8_sentence_cap" | "L9_neutral_fallback" | "L10_unauthorized_scheduling" | "L11_slot_offer_replaced"` — exactly the eleven layers of audit §2.3 (L0…L11, twelve ids because the audit numbers from L0).
- `export function hashText(text: string): string` — `createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12)` from `node:crypto`.
- `export function logTurnTrace(trace: TurnTrace): void` — emits exactly one line: `console.info(JSON.stringify({ event: "mariana_turn", ...trace }))`.

Why `JSON.stringify` and not the existing `console.info({...})` style of `execute-next-action.ts:205`: `console.info(object)` goes through `util.inspect`, which truncates nested objects beyond depth 2 and wraps wide objects over several lines. The trace has a nested `usage` object and an array of rewrite records, so the inspect form would silently lose fields and break "one line per turn". A single `JSON.stringify` line is greppable (`grep '"event":"mariana_turn"'`) and `jq`-able. Pino is not used directly because `src/lib/logger.ts` only exports Fastify logger *options*, not an instance, and the turn runs in a background worker with no request context.

**Log line shape.** One JSON object, flat except `usage` and `rewrites`.

| Field | Type | Source |
|---|---|---|
| `event` | `"mariana_turn"` (literal) | constant |
| `turnId` | string (uuid) | the anchor task id — `task.id` in `handleProcessInboundMessage`, threaded into `generateMarianaResponse` as a new optional `traceTurnId` param |
| `conversationId` | string (uuid) | `activeConversation.id` |
| `leadId` | string (uuid) | `leadId` param |
| `outcome` | `"replied" \| "model_error" \| "guardrail_throw"` | `"replied"` on the success path; `"model_error"` from step 9's catch; `"guardrail_throw"` when L2/L4 throw (F-08's path, unchanged behaviour, now visible) |
| `model` | string | `env.GEMINI_MODEL` on the request side |
| `modelVersionReturned` | string \| null | `response.modelVersion` (`agent.ts:288`) |
| `temperature` | number | `env.GEMINI_TEMPERATURE` |
| `thinkingLevel` | string | `env.GEMINI_THINKING_LEVEL` |
| `maxOutputTokens` | number | `env.GEMINI_MAX_OUTPUT_TOKENS` |
| `latencyMs` | number | existing `Date.now() - startedAt` (`agent.ts:286`) |
| `usage.promptTokens` | number \| null | `response.usageMetadata.promptTokenCount` |
| `usage.candidatesTokens` | number \| null | `…candidatesTokenCount` |
| `usage.thoughtsTokens` | number \| null | `…thoughtsTokenCount` (confirms the thinking level took effect) |
| `usage.totalTokens` | number \| null | `…totalTokenCount` |
| `finishReason` | string \| null | `response.candidates?.[0]?.finishReason` — detects `MAX_TOKENS` truncation |
| `stage` | string | `turnStage.stage` (pre-turn) |
| `postTurnStage` | string | `postTurnStage.stage` |
| `questionKey` | string \| null | `postTurnStage.questionKey` (null when the backend adds no question) |
| `requestedNextAction` | string | `response.result.nextAction` — what the model asked for |
| `executedAction` | string | `nextActionResult.action` / `.status` — what the gate executed |
| `actionBlockedReason` | string \| null | from `executeNextAction`'s blocked branch, when present |
| `commercialAccessLevel` | 1 \| 2 \| 3 | `commercialAccess.level`, returned in metadata by `agent.ts` |
| `rawReplyLength` | number | `.length` of the model's `reply` **before** any layer |
| `rawReplyHash` | string (12 hex) | `hashText(rawReply)` |
| `sentReplyLength` | number | `.length` of the text actually enqueued |
| `sentReplyHash` | string (12 hex) | `hashText(sentReply)` |
| `pureBackendText` | boolean | `true` when no model sentence survived: computed as `rewrites` containing any of `L0`, `L3`, `L5`, `L9`, `L10`, `L11` *and* the final text sharing no sentence with the raw reply. Implemented as a pure helper `isPureBackendText(rawReply, sentReply, rewrites)` in `turn-trace.ts`, unit-tested |
| `rewrites` | `RewriteRecord[]` | one entry per layer that **changed** the text; layers that ran and changed nothing emit nothing |

`RewriteRecord.detail` carries counts where they are known: `{ questionsDropped: 2 }` (L6), `{ greetingsDropped: 1 }` (L7), `{ sentencesTruncated: 1, cap: 2 }` (L8), `{ fallbackText: "neutral_1" }` (L9 — the label, never the client-visible string... the fallback text is backend-authored, so the label suffices).

**Privacy rule, mechanical.** The `TurnTrace` type contains **no field whose type allows free text written by the client or by the model**: every text is reduced to `number` (length) and a 12-hex-char `hashText` at the call site. The phone number is never passed in — only `leadId`. Therefore no client message, no reply body, no system prompt, no knowledge content and no phone can appear in the line even by accident; a future field that would carry text requires changing the exported type, which the review will catch. Client text is never even hashed: only Mariana's own (model or backend) reply text is hashed.

**Hash and truncation choice.** SHA-256, hex, first 12 characters (48 bits). SHA-256 because it is in `node:crypto` with no dependency; 12 characters because the only questions asked of the hash are "is the sent text the same string as the raw reply?" and "is this the same boilerplate as in that other turn?", for which 48 bits over a corpus of at most a few hundred thousand turns has negligible collision probability (birthday bound ≈ 1 in 10⁵ at 10⁶ turns), while a full 64-character digest would triple the line size. No salt: the hashed strings are Mariana's own replies, never the client's words, so dictionary inversion of her own boilerplate reveals nothing private — and cross-deploy comparability is worth more than resistance to inverting a text we also store in `messages`.

**Example line (fake data):**

```
{"event":"mariana_turn","turnId":"0f3c5a21-0000-4000-8000-000000000001","conversationId":"0f3c5a21-0000-4000-8000-000000000002","leadId":"0f3c5a21-0000-4000-8000-000000000003","outcome":"replied","model":"gemini-3.5-flash-lite","modelVersionReturned":"gemini-3.5-flash-lite","temperature":0.3,"thinkingLevel":"LOW","maxOutputTokens":1024,"latencyMs":1432,"usage":{"promptTokens":5871,"candidatesTokens":96,"thoughtsTokens":212,"totalTokens":6179},"finishReason":"STOP","stage":"info","postTurnStage":"consultant_offer","questionKey":"consultantOffer","requestedNextAction":"continue_qualification","executedAction":"continue_qualification","actionBlockedReason":null,"commercialAccessLevel":1,"rawReplyLength":268,"rawReplyHash":"9f2b7c41ad03","sentReplyLength":191,"sentReplyHash":"41d8ee0b7c92","pureBackendText":false,"rewrites":[{"layer":"L6_dropped_questions","lengthBefore":268,"lengthAfter":214,"hashBefore":"9f2b7c41ad03","hashAfter":"b70c1a9e4452","detail":{"questionsDropped":1}},{"layer":"L8_sentence_cap","lengthBefore":214,"lengthAfter":129,"hashBefore":"b70c1a9e4452","hashAfter":"5c3390ba1e77","detail":{"sentencesTruncated":1,"cap":2}}]}
```

**Where it is called.** Once per turn, at the end of `generateMarianaResponse` (after the scheduling-offer block, i.e. after `generateMarianaResponse.ts:694`), so it sees both ends including L11; and once in the model-failure catch of step 9. To keep the layers reportable without restructuring, instrumentation is additive:
- `agent.ts` returns the L0–L4 records plus the raw reply hash/length in `metadata` (new fields, existing fields untouched);
- `conversation-stage.ts` gains `composeStageReplyWithTrace(input): { reply, rewrites }` and `composeStageReply` becomes a one-line wrapper returning `.reply`, so no existing caller or test changes;
- `persistAuthorizedAssistantReply` adds `rewrites` to its returned object (L5, L10);
- the L11 record is produced inline in `generateMarianaResponse` where `finalReply` is replaced.

### Item 2 — model config in `.env`

Field names verified in the installed SDK typings, `node_modules/@google/genai/dist/genai.d.ts`:
- `GenerateContentConfig` (declared at line 6121) has `temperature` (line ~6143), `maxOutputTokens` (~6161), `thinkingConfig?: ThinkingConfig` (~6266), and also `abortSignal` and `topP`/`topK`.
- `ThinkingConfig` (line 15888) has `includeThoughts`, `thinkingBudget` ("0 is DISABLED, -1 is AUTOMATIC… model dependent") and `thinkingLevel?: ThinkingLevel`.
- `ThinkingLevel` (line 15902) = `THINKING_LEVEL_UNSPECIFIED | MINIMAL | LOW | MEDIUM | HIGH`.
- The same file, line 13753, states the governing fact: **"Starting from Gemini 3.5 models, the old thinking_budget will no longer be supported and will result in a user error if set. Instead, users should use the thinking_level parameter to control the maximum thinking depth."**
- Usage counters: `GenerateContentResponseUsageMetadata` has `promptTokenCount` (6485), `candidatesTokenCount` (6481), `thoughtsTokenCount` (6489), `totalTokenCount` (6495).

So Davi's `GEMINI_THINKING_BUDGET` becomes **`GEMINI_THINKING_LEVEL`** ("or the SDK's equivalent setting", per the brief): a token budget on a 3.5 model is an error, not a setting.

| Variable | Type / validation in `env.ts` | Default | Why |
|---|---|---|---|
| `GEMINI_MODEL` | `z.string().min(1).regex(/^gemini-[0-9]+(?:\.[0-9]+)?-(?:flash|flash-lite|pro)(?:-[a-z0-9.-]+)?$/)` | `gemini-3.5-flash-lite` | Roadmap D-02 keeps lite until Package A2 decides. The regex rejects the typo class that caused N6 (`gemini-3.6-flash-lite` still matches the shape, so this is a partial guard only — see the honest note in "Risks") |
| `GEMINI_TEMPERATURE` | `z.coerce.number().min(0).max(2)` | `0.3` | Brief; audit §2.1.3 option B. Low temperature is what makes the greeting rule (F-27) obeyable |
| `GEMINI_THINKING_LEVEL` | `z.enum(["MINIMAL","LOW","MEDIUM","HIGH"])` | `LOW` | See `explicacao.md`; reasoning summarised below |
| `GEMINI_MAX_OUTPUT_TOKENS` | `z.coerce.number().int().min(128).max(8192)` | `1024` | The response is JSON (reply + `leadUpdate` + `evidenceUsed`), and on this SDK thought tokens are billed as output. The audit suggested 400; 400 risks `finishReason: MAX_TOKENS` → truncated JSON → `JSON.parse` throw (`agent.ts:264`) → silent client. 1024 keeps a wide margin; the trace's `finishReason` and `usage.candidatesTokens` tell us whether it can be lowered later |

Thinking-level default **`LOW`**, not `MINIMAL` and not `MEDIUM`: a `*-flash-lite` tier left unset runs at its minimum reasoning depth (audit §2.1), which is the proximate cause of "ela não raciocina"; `LOW` is the smallest explicit step above that, costs roughly 1.5–3× option A with +0.5–2 s latency (audit §2.1.3), and that latency is invisible against the ~20 s end-to-end budget of audit §1.1 dominated by the 15 s debounce. `MEDIUM`/`HIGH` are left for Davi to try in `.env` without a deploy, which is exactly what Package A2's comparison needs.

`env.ts` keeps its two-part style: an entry in `envSchema` **and** an entry in `buildEnvInput` (the function is the real input list; a schema-only addition would never be read). Numeric vars pass the raw string through so an invalid value fails validation instead of silently falling back, following the `WHATSAPP_SEND_TIMEOUT_MS` comment at `env.ts:100-101`.

### Item 3 — model failure reaches the client

New `export class ModelUnavailableError extends Error` in `src/ai/agent.ts` (or `src/ai/model-errors.ts`), wrapping *only* the `ai.models.generateContent` rejection and the empty/invalid-JSON responses at `agent.ts:250-266`, with `cause` preserved and a `kind` field (`"transport" | "empty_response" | "invalid_json"`). Guardrail throws (L2 `validate-response.ts:76-80`, L4 `mariana-safety.ts:117-130`) are **not** wrapped and keep their current behaviour.

`handleProcessInboundMessage` (`autonomous-task-handlers.ts:190`) wraps the `generateMarianaResponse` call in `try/catch`. On `ModelUnavailableError`:
1. insert one assistant `messages` row with the notice text (the conversation record stays honest);
2. `enqueueOutboundMessage({ conversationId, eventId, idempotencyKey: runKey, leadId, messageId, payload: { kind: "text", text: MODEL_FAILURE_NOTICE } })` — **the same `runKey`** already computed at `autonomous-task-handlers.ts:167`, so a retry can never double-send;
3. `markMessagesProcessed(messageIds)` and `markEventProcessed(eventId)`;
4. `logTurnTrace({ outcome: "model_error", … })` plus a `console.error({ event: "mariana_model_failure", kind, model, conversationId, leadId })`;
5. return `{ modelFailureNotice: true, outboundQueued: true }` — the handler **completes**, so the task is not retried into `failed` and the client is not silent.

Proposed client text (Davi's to approve):

> **"Desculpe, tive uma falha técnica aqui e não consegui processar sua mensagem agora. Pode me enviar de novo em alguns instantes?"**

Properties checked against the code, deliberately:
- contains no `CONSULTANT_OFFER_MARKERS` and no `CONSULTANT_REASON_QUESTION`, so `detectPendingOffer` (`pending-offer.ts:24-44`) returns `null` on the next turn — the "clear affirmative" invariant of `CLAUDE.md` cannot be armed by it;
- matches none of the six `SCHEDULING_COMMITMENT_PATTERNS` (`generateMarianaResponse.ts:188-195`), so it carries no scheduling promise;
- asks the client to resend, which is the only true statement available: the task is completed, so nothing will retry on its own.

Coverage, stated plainly:
- **covers** RC-4 / N6 (wrong model id, 404, transport failure after the three retries of `client.ts:4-11`), empty response, invalid JSON — the three ways `agent.ts` currently throws for a model reason, on the inbound-message path;
- **does not cover** F-08's throwing guardrails (L2 invented `evidenceUsed` id; L4 `FORBIDDEN_PATTERNS`): those are a content problem whose fix is "drop the offending sentence", which **changes conversation behaviour** and belongs to Package C2/WP-7. They stay out of scope here, but step 7 makes them *visible* (`outcome: "guardrail_throw"`), which is the Package A promise;
- **does not cover** the other silent paths of F-03/F-20 (unanswered button taps, lease-expired events): Packages B and E;
- **does not add** a request deadline. There is no `abortSignal`/timeout on the Gemini call (audit §2.1); a hung call still ends as a lease expiry, not as a `ModelUnavailableError`. Out of scope, flagged for Package E.

### Item 4 — test-safety hardening

Order: `vitest` removal (highest risk, zero behaviour), `setup-test-db.ts` assignment (one line), guard allowlist, preload assertion. Hole 6 (`RELIABILITY_WORKERS_ENABLED` defaulting to `"true"` in `env.ts:43`) is **deliberately left for later**: it is only exploitable through holes 1 and 2, and changing a production default belongs with Package E's reliability work.

## Steps

### Batch A — model config (steps 1–3)

**Step 1 — `env.ts`: the four Gemini variables.**
- Files: `src/env.ts` (`envSchema` 19-64, `buildEnvInput` 68-105).
- Change: add `GEMINI_MODEL`, `GEMINI_TEMPERATURE`, `GEMINI_THINKING_LEVEL`, `GEMINI_MAX_OUTPUT_TOKENS` with the validations and defaults in the Design table, keeping alphabetical order; pass raw strings (`source.X || undefined`) for the three constrained ones so a bad value fails validation.
- Acceptance tests — `src/tests/env.test.ts` (unit, already in `test:unit`):
  - `"parseEnv aplica os defaults do Gemini"` — given `VALID_SOURCE` with no Gemini tuning vars; when `parseEnv`; then `GEMINI_MODEL === "gemini-3.5-flash-lite"`, `GEMINI_TEMPERATURE === 0.3`, `GEMINI_THINKING_LEVEL === "LOW"`, `GEMINI_MAX_OUTPUT_TOKENS === 1024`. **Red first** (fields do not exist).
  - `"parseEnv recusa um nome de modelo fora do formato"` — given `GEMINI_MODEL: "gpt-4o"`; when `parseEnv`; then it throws matching `/GEMINI_MODEL/`. **Red first.**
  - `"parseEnv recusa temperatura e nível de raciocínio inválidos"` — given `GEMINI_TEMPERATURE: "3"` / `GEMINI_THINKING_LEVEL: "ULTRA"` / `GEMINI_MAX_OUTPUT_TOKENS: "10"`; then throws naming each variable. **Red first.**
- Invariants: none at risk. A missing variable must *default*, never fail boot, or production stops on deploy.

**Step 2 — `agent.ts`: use the configuration.**
- Files: `src/ai/agent.ts:36` (remove the constant, read `env.GEMINI_MODEL`), `agent.ts:240-248` (the call).
- Change: extract a pure `export function buildModelRequestConfig({ systemInstruction }): GenerateContentConfig` returning `{ responseJsonSchema, responseMimeType, systemInstruction, temperature: env.GEMINI_TEMPERATURE, maxOutputTokens: env.GEMINI_MAX_OUTPUT_TOKENS, thinkingConfig: { thinkingLevel: env.GEMINI_THINKING_LEVEL } }`, and have the call site use it. The pure function is the test seam — `ai` stays a module-level singleton and **no API call happens in any test**.
- Acceptance tests — new unit file `src/tests/agent-model-config.test.ts`, added to the `test:unit` list in `package.json:21` and to `docs/CODEMAP.md`:
  - `"buildModelRequestConfig envia modelo, temperatura, nível de raciocínio e limite de saída"` — given the env defaults; when called; then the config has `temperature: 0.3`, `maxOutputTokens: 1024`, `thinkingConfig.thinkingLevel === "LOW"`, and `responseMimeType`/`responseJsonSchema` unchanged. **Red first** (the function does not exist; today the config has three keys).
  - `"o modelo vem do ambiente, não de uma constante"` — assert `MODEL`-style hard-coding is gone by asserting the resolved model equals `env.GEMINI_MODEL`. **Red first.**
- Invariants: "the AI is never the authority on IDs, availability or authorization" — untouched; this step changes only sampling parameters.
- *(criterion derived from Davi's brief — redação de R-REL-07 não disponível, pendente de confirmação.)*

**Step 3 — document the variables in `.env.example`.**
- Files: `.env.example` (the "AI - Google Gemini" block, line 23-26).
- Change: four commented entries with the defaults and a note that `GEMINI_THINKING_LEVEL` replaces a token budget because Gemini 3.5 rejects `thinkingBudget`.
- Acceptance test: none automated (documentation). Proof: `grep -c GEMINI_ .env.example` ≥ 5 and the names match `envSchema`. `.env` itself is **not** touched by the implementer — Davi sets the real values.

### Batch B — the trace module and the layer records (steps 4–6)

**Step 4 — `src/lib/turn-trace.ts`.**
- Files: new `src/lib/turn-trace.ts`.
- Change: the types, `hashText`, `isPureBackendText`, `logTurnTrace` exactly as in the Design section. No imports beyond `node:crypto`.
- Acceptance tests — new unit file `src/tests/turn-trace.test.ts` (add to `test:unit` and CODEMAP):
  - `"logTurnTrace emite uma única linha JSON com event mariana_turn"` — given a full trace object; when `logTurnTrace` with `console.info` stubbed; then exactly one call, its argument is a string, `JSON.parse` succeeds, `event === "mariana_turn"`, and the string contains no `\n`. **Red first.**
  - `"o rastro nunca contém texto do cliente nem telefone"` — given a trace built from a turn whose client text is `"meu telefone é 5531999999999"` and whose reply is `"Oi, Davi"`; then the serialised line contains neither substring and no 11-digit sequence. **Red first.**
  - `"hashText é estável, hexadecimal e de 12 caracteres"`; `"isPureBackendText detecta resposta 100% do backend"` with the L9/L11 cases of audit §2.3.1. **Red first.**
- Invariants: privacy (`R-SEC-03` family, wording unavailable). Protected by the type plus the second test.

**Step 5 — `agent.ts` reports L0–L4 and the raw reply.**
- Files: `src/ai/agent.ts` (`GenerateMarianaReplyResult.metadata` 75-82; the L0 short-circuit 198-213; L1 at 268; L3 inside `validateMarianaEvidence`; the throws at L2/L4).
- Change: add to `metadata`: `rawReplyLength`, `rawReplyHash`, `finishReason`, `commercialAccessLevel`, `requestedNextAction`, `usage` kept as is, plus `rewrites: RewriteRecord[]` holding L0 (short-circuit, raw = `""`), L1 (when `sanitizeCommercialIdentity` changed the string) and L3 (when `validateMarianaEvidence` replaced the reply — compare before/after). For L2/L4 the function still throws; it attaches the partial records to the error (`error.turnRewrites`) so step 7 can log them.
- Acceptance tests — `src/tests/agent-model-config.test.ts` for the pure parts, plus `src/tests/knowledge-response.test.ts`/`src/tests/commercial-policy.test.ts` style helpers where the layer functions are already unit-testable:
  - `"metadata traz hash e comprimento da resposta crua"` — given a fake `generateContent` result injected through a new optional `generateContentFn` param on `generateMarianaReply` (default = the real `ai`), reply `"Texto A. Texto B?"`; then `metadata.rawReplyLength === 17` and `metadata.rawReplyHash === hashText("Texto A. Texto B?")`. **Red first.**
  - `"o curto-circuito de nível 3 é registrado como L0"` — given a level-3 message (`"qual o valor da carta?"`); then `metadata.rewrites[0].layer === "L0_level3_short_circuit"` and no model call happened. **Red first.**
- Invariants: none changed; the function's behaviour is identical, only the returned metadata grows. Risk: the new optional `generateContentFn` param must default to the real client so production is unchanged — asserted by a test that the default is `ai.models.generateContent`.

**Step 6 — `composeStageReplyWithTrace` (L6–L9).**
- Files: `src/services/conversations/conversation-stage.ts:381-425`.
- Change: rename the body to `composeStageReplyWithTrace(input): { reply: string; rewrites: RewriteRecord[] }`, recording L6 (`questionsDropped`), L7 (`greetingsDropped`), L8 (`sentencesTruncated`, `cap`) and L9 (`fallbackText` label). `export function composeStageReply(input): string { return composeStageReplyWithTrace(input).reply; }` so every existing caller and test is untouched.
- Acceptance tests — `src/tests/services/conversation-stage.test.ts` (unit, already in `test:unit`):
  - `"composeStageReplyWithTrace registra as perguntas removidas"` — given `modelReply` = the three-sentence example of audit §2.3.1 with a trailing question and `question: null`; then `rewrites` contains `L6_dropped_questions` with `detail.questionsDropped === 1` and matching `lengthBefore`/`lengthAfter`. **Red first.**
  - `"registra o corte de frases e o fallback neutro"` — the two other §2.3.1 cases (3rd fact dropped to fit the offer → `L8_sentence_cap`; question-only reply → `L9_neutral_fallback`). **Red first.**
  - `"composeStageReply continua devolvendo a mesma string"` — a regression guard over three existing fixtures. Green before and after (that is the point).
- Invariants: none. Text output must be byte-identical; the wrapper test enforces it.

### Batch C — assemble and emit (steps 7–8)

**Step 7 — `generateMarianaResponse` assembles and logs the turn.**
- Files: `src/services/conversations/generateMarianaResponse.ts` (`persistAuthorizedAssistantReply` 217-264 → add `rewrites` for L5 and L10; the compose calls 589-599 → use `composeStageReplyWithTrace`; the L11 replacement at ~648-655; the return at 695-706; the params interface at 58-68 → optional `traceTurnId?: string`), and a `try/catch` around the whole turn that logs `outcome: "guardrail_throw"` and rethrows.
- Change: collect the records, compute `pureBackendText`, call `logTurnTrace(...)` exactly once before the `return`, and include the new fields in `GenerateMarianaResponseResult.metadata`.
- Acceptance tests:
  - `src/tests/services/generate-mariana-response-authorization.test.ts` (unit, already in `test:unit`): `"persistAuthorizedAssistantReply registra L5 e L10"` — given a resolved action `request_consultant` / an unauthorised scheduling request; then the result's `rewrites` name `L5_request_consultant_override` / `L10_unauthorized_scheduling` with before/after lengths. **Red first.**
  - `src/tests/services/generate-mariana-response.test.ts` (DB suite): `"um turno emite exatamente uma linha mariana_turn com as camadas que alteraram o texto"` — given a seeded lead/conversation and a stubbed `generateMarianaReplyFn` returning a reply with a question and three sentences; when `generateMarianaResponse` runs with `console.info` captured; then exactly one captured line has `event === "mariana_turn"`, `turnId` equals the passed id, `requestedNextAction` and `executedAction` are both present, `rewrites` contains `L6`, and the line contains neither the client's text nor the lead's phone. **Red first.**
  - Same file: `"uma exceção de guardrail ainda é registrada como guardrail_throw"` — given a stub whose reply trips `assertSafeMarianaReply`; then the call still rejects (behaviour unchanged) **and** one `mariana_turn` line with `outcome: "guardrail_throw"` was emitted. **Red first.**
- Invariants at risk: **"a duplicate inbound event is never processed twice"** and the message-persistence path. Protected because the step adds no DB write and no early return — the logging call sits after every existing write, and the `catch` rethrows unchanged.
- *(criterion derived from Davi's brief — redação de R-REL-07 não disponível, pendente de confirmação.)*

**Step 8 — thread `turnId` from the task.**
- Files: `src/services/conversations/autonomous-task-handlers.ts:190-196` (pass `traceTurnId: task.id`).
- Acceptance test: `src/tests/reliability/` DB test (the existing inbound-task test file, name to be confirmed by the implementer from `src/tests/reliability/`): `"o rastro do turno usa o id da task âncora"` — given one inbound task; then the emitted `mariana_turn` line's `turnId` equals the task id. **Red first.**

### Batch D — honest model failure (steps 9–11)

**Step 9 — `ModelUnavailableError`.**
- Files: new `src/ai/model-errors.ts`; `src/ai/agent.ts:240-266` (wrap the call, the empty response and the JSON parse).
- Acceptance tests — new unit file `src/tests/model-failure-notice.test.ts` (add to `test:unit` and CODEMAP):
  - `"um erro de transporte do Gemini vira ModelUnavailableError"` — given `generateContentFn` rejecting with `{ status: 404, message: "models/gemini-3.6-flash-lite not found" }` (the N6 error); then `generateMarianaReply` rejects with `ModelUnavailableError`, `kind === "transport"`, `cause` preserved. **Red first.**
  - `"resposta vazia e JSON inválido também viram ModelUnavailableError"` with `kind` `"empty_response"` / `"invalid_json"`. **Red first.**
  - `"um erro de guardrail NÃO vira ModelUnavailableError"` — given a reply tripping `FORBIDDEN_PATTERNS`; then the rejection is the existing error type. **Red first** (guards the scope line against F-08).

**Step 10 — the notice text constant.**
- Files: new `MODEL_FAILURE_NOTICE` constant (in `src/services/conversations/model-failure-notice.ts` or beside `DEFAULT_FALLBACK_REPLY` in `qualification-gaps.ts` — implementer's choice, one place).
- Acceptance tests — `src/tests/model-failure-notice.test.ts`:
  - `"o aviso de falha não arma oferta pendente"` — given `detectPendingOffer(MODEL_FAILURE_NOTICE)`; then `null`. **Red first.**
  - `"o aviso de falha não promete agendamento"` — given the notice; then `hasSchedulingCommitment`-equivalent assertion is false (export the helper or assert via `persistAuthorizedAssistantReply`). **Red first.**
  - `"o aviso é curto e em português"` — length ≤ 160 chars (one WhatsApp bubble) and exact-text pin, so a future edit is a conscious decision Davi re-approves. **Red first.**
- Invariants: the pending-offer invariant of `CLAUDE.md` — protected by the first test.

**Step 11 — the handler completes instead of failing.**
- Files: `src/services/conversations/autonomous-task-handlers.ts:190-232`.
- Change: the `try/catch` of the Design section (persist assistant message → `enqueueOutboundMessage` with the existing `runKey` → mark processed → log → return).
- Acceptance tests — DB suite, `src/tests/reliability/` (new test in the existing inbound-task file, or a new `src/tests/reliability/model-failure.test.ts`):
  - `"falha do modelo enfileira o aviso e conclui a task"` — given a seeded lead/conversation and an inbound task, with `generateMarianaResponse` stubbed to throw `ModelUnavailableError`; when the handler runs; then (a) exactly one `outbound_messages` row with `idempotencyKey === runKey` and `payload.text === MODEL_FAILURE_NOTICE`, (b) one assistant `messages` row with that text, (c) the task result is not a throw, (d) the inbound messages are `processedAt`-marked and the webhook event is `processed`. **Red first** (today the handler throws and nothing is enqueued).
  - `"o aviso de falha nunca é enviado duas vezes"` — given the same task executed twice; then still exactly one `outbound_messages` row (the `runKey` dedup at lines 172-182 already covers it). **Red first** for the first assertion, green by construction for the second.
  - `"uma falha que não é do modelo continua falhando a task"` — given the stub throwing a plain `Error`; then the handler rejects and nothing is enqueued. **Red first** (guards against swallowing every error).
- Invariants at risk: **"an outbound message that may have been accepted by Meta never goes back to `pending`"** and **"a duplicate inbound event is never processed twice"**. Protected by reusing `runKey` (no new idempotency key) and by marking the messages/event processed exactly as the success path does.
- *(criterion derived from Davi's brief — redação de S-17 não disponível, pendente de confirmação.)*

### Batch E — test safety (steps 12–15, plus optional 16)

**Step 12 — remove `vitest`.**
- Files: `package.json:33`, `package-lock.json` (regenerated by `npm install`, not hand-edited).
- Change: delete the `vitest` line from `dependencies`; run `npm install` to update the lock; do **not** run any test runner other than the project's scripts.
- What proves it closed: `grep -rn "vitest" --include='*.ts' --include='*.js' --include='*.mjs' --include='*.json' . | grep -v node_modules | grep -v package-lock` → no hits; `ls node_modules/.bin/vitest` → absent after install; `npm run build`, `npx tsc --noEmit` and `npm run test:unit` still pass. No test asserts the absence (a test cannot usefully assert a missing dependency); the proof is the grep in `progress.md`, which the tester repeats.
- Invariants: none. Risk: the lockfile churn must contain no unrelated upgrades — `git diff --stat package-lock.json` is reported to Davi, who commits.

**Step 13 — `setup-test-db.ts` must not hold Neon in `process.env`.**
- Files: `src/tests/support/setup-test-db.ts:19`.
- Change: `const { DATABASE_URL: testUrl } = Object.assign(process.env, resolveTestDatabaseEnv(process.env));` — or, clearer, resolve into a const and then `Object.assign(process.env, resolved)` before the pool is opened at line 24 and before the `DROP SCHEMA` at line 26. `NODE_ENV=test` and `RELIABILITY_WORKERS_ENABLED=false` come along with it, which also hardens the spawned `drizzle-kit push` at line 39.
- Acceptance test — `src/tests/test-database-guard.test.ts` (unit, already in `test:unit`): `"o setup de banco de teste reescreve DATABASE_URL antes de qualquer statement"` — given a fake `source` with `DATABASE_URL` on a Neon-like host and a valid local `TEST_DATABASE_URL`; when the new exported helper `applyTestDatabaseEnv(source)` runs; then `source.DATABASE_URL` equals the test URL, `source.NODE_ENV === "test"`, `source.RELIABILITY_WORKERS_ENABLED === "false"`. **Red first** (the helper does not exist). The helper is what `setup-test-db.ts` calls, so the regression is caught by a unit test that never opens a connection.
- Invariants: the `CLAUDE.md` safety rule "never write to Neon". This step is the only one that touches the destructive script; it must not change what it drops or seeds.

**Step 14 — guard: allowlist instead of a one-vendor denylist.**
- Files: `src/tests/support/test-database-guard.ts:52-57`.
- Change: keep the explicit `neon.tech` message, and add: the host must be `localhost`, `127.0.0.1` or `::1`, unless `ALLOW_REMOTE_TEST_DB === "1"` is set, in which case log a loud warning naming host and database (never the password, per `CLAUDE.md`).
- Acceptance tests — `src/tests/test-database-guard.test.ts`:
  - `"recusa um host remoto que não é neon.tech"` — given `TEST_DATABASE_URL` on `db.example.com`; then `UnsafeTestDatabaseError`. **Red first** (today it is accepted).
  - `"aceita localhost e 127.0.0.1"` — green before and after.
  - `"permite host remoto só com ALLOW_REMOTE_TEST_DB=1"`. **Red first.**
- Risk: this can break a legitimate workflow if Davi ever points `TEST_DATABASE_URL` at a non-local Docker host; the escape hatch covers it. Question for Davi.

**Step 15 — `unit-test-preload.ts`: assert the invariant instead of relying on dotenv's default.**
- Files: `src/tests/support/unit-test-preload.ts`.
- Change: after the `Object.assign`, import `src/env.ts` is *not* forced; instead add an explicit assertion executed at preload time — if `process.env.DATABASE_URL` does not equal the unreachable sentinel, throw — plus a comment stating the dependency on dotenv `override: false`.
- What proves it closed: a unit test cannot easily re-run a preload; the proof is `npm run test:unit` passing (sentinel intact) plus a deliberate manual counter-check the tester can run: `DATABASE_URL=postgresql://x@127.0.0.1:1/none npm run test:unit` still passes, and a doctored `override: true` would now abort. I accept this as the weakest proof in the batch and say so.

**Step 16 (OPTIONAL, recommended, needs Davi's yes) — close holes 1 and 2 at the source.**
- Files: `src/db/connections.ts`.
- Change: at module load, refuse a non-local `DATABASE_URL` when the process is a test runner (`process.execArgv.includes("--test") || process.argv.includes("--test")`), unless `ALLOW_REMOTE_TEST_DB === "1"`. This is what makes `npx vitest`, `npx tsx --test file.ts` and an IDE runner safe, not just the three blessed npm scripts.
- Acceptance test — new unit test in `src/tests/test-database-guard.test.ts` over an extracted pure predicate `isForbiddenTestConnection({ url, argv, execArgv, allowRemote })`, so no connection is opened. **Red first.**
- Why optional: it puts a guard in a **production** module. The predicate is pure and only fires under `--test`, but it is still the one step in this package that could, if wrong, affect production boot. I recommend it with the pure-predicate design; Davi decides.

## Out of scope (deliberately)

- Any conversation-behaviour change: F-08 (guardrails dropping a sentence instead of throwing), F-14 (stop deleting questions, raise the cap, prepend instead of replace), F-27 (greeting filter), F-09, F-11, F-13 → Packages C1/C2.
- The model choice itself. The default stays `gemini-3.5-flash-lite` per D-02; the lite-vs-flash comparison is Package A2's simulator run, with Davi's permission for real API calls. I run no simulator and no API call.
- A live startup probe that the configured model exists (`models.get`). Needs a real API call; question for Davi; would belong to A2.
- A request deadline / `abortSignal` on the Gemini call (audit §2.1 "Timeout: none") → Package E.
- `TURN_TRACE_VERBOSE` (full raw reply and sent text at `debug`), proposed in audit §2.3.3. Davi's item 1 does not ask for it and it is the only part of the trace that would touch message text; question for Davi, otherwise Package A2 where it is most useful.
- Persisting the trace in a table: would need a migration → **frozen**, out of scope.
- Hole 6 (`RELIABILITY_WORKERS_ENABLED` defaults to `"true"` in `env.ts:43`) → with Package E.
- The false-confidence tests F1–F7 of coverage report §3: they are test-correctness problems owned by the tester and tied to behaviour packages B/C.
- `docs/specs/MARIANA_BEHAVIOR_SPEC.md`: I do not write or reconstruct it. Davi restores and commits it (F-01, WP-15).

## Questions for the owner

1. **The lost v1.1 spec.** `docs/specs/MARIANA_BEHAVIOR_SPEC.md` does not exist and the untracked root copy the audit read is gone and unrecoverable from git. Can you paste or restore it and commit it? Until then every `R-REL-07`/`S-17` criterion in this plan is marked as derived from your brief. **This does not block implementation of Package A**, but it does block final acceptance against the spec.
2. **The client-failure message.** Do you approve the exact text: *"Desculpe, tive uma falha técnica aqui e não consegui processar sua mensagem agora. Pode me enviar de novo em alguns instantes?"*
3. **Thinking level.** `GEMINI_THINKING_LEVEL=LOW` as the default (my recommendation), or `MEDIUM` right away? Note that a token budget (`GEMINI_THINKING_BUDGET`) is not usable: the SDK typings state Gemini 3.5 rejects `thinkingBudget` and requires `thinkingLevel`.
4. **Output cap.** `GEMINI_MAX_OUTPUT_TOKENS=1024` (my recommendation, margin against truncated JSON) or the audit's 400?
5. **Step 16.** Do you want the source-level test-connection guard in `src/db/connections.ts` (closes `npx vitest` and `npx tsx --test` for good, but touches a production module), or do you prefer to stop at steps 12–15?
6. **`TURN_TRACE_VERBOSE`.** Do you want the opt-in verbose mode (full texts at `debug`, off by default) now, or in A2?
7. **Remote test DB.** Step 14 restricts `TEST_DATABASE_URL` to localhost with an `ALLOW_REMOTE_TEST_DB=1` escape hatch. Any workflow of yours that needs a non-local test database?

No step is BLOCKED on the migration freeze. Nothing is implemented and nothing is committed until Davi answers.
