# Mariana — end-to-end audit (Phase 1, read-only)

Task id: `2026-10-22-audit` · Date: 2026-10-22 · Branch: `develop` @ `e402b13`
Scope: read-only. No product code, test, migration, config or `.env` file was modified. Nothing ran against Neon, WhatsApp, Google Calendar or the Gemini API.

## 0. Repository state at the start of the audit

`git status` (branch `develop`, up to date with `origin/develop`), untracked only:

```
?? .claude/
?? MARIANA_BEHAVIOR_SPEC.md
?? NEON_SNAPSHOT_2026-10-22.md
?? docs/AGENT_TEAM.md
?? docs/specs/
```

`git log --oneline -15`:

```
e402b13 feat: enhance conversation handling and testing
2a2d657 feat: implement pending offer handling and improve qualification fallback logic
cac26c0 feat: update test commands and improve error handling
52d547c fix: time out WhatsApp sends and record them as unknown
59507b2 fix: map raw RETURNING rows to schema types in task and outbound claims
a601b1d test: isolate DB tests with guarded reset, schema bootstrap and seed
4120764 docs: add CLAUDE.md with safety rules, test commands and invariants
b0a8d72 feat: implement atomic state transition and message queuing in scheduling handlers
c9ac30c feat: enhance conversation context and qualification handling
009fff9 feat: add recordAcceptedSend function and related tests for outbound message persistence
c877c2b feat: implement inbound message batching and enhance task handling logic
800fecf feat: enhance scheduling intent handling and add related tests
85ee7a3 feat: enhance scheduling intent handling and update related tests
e05be8d fix: revert model version to gemini-3.5-flash-lite
b207873 refactor: remove unused schedulingSlots import and update references …
```

### 0.1 Correction to the brief: the yardstick spec is NOT missing

The brief states that `MARIANA_BEHAVIOR_SPEC.md` does not exist. **It does exist**, at `/home/davi-curty/Documentos/Programing/Projects/mariana/MARIANA_BEHAVIOR_SPEC.md` (repo **root**, not `docs/specs/`), version 1.0 dated 2026-10-21, 9182 bytes, **untracked**. It contains the full rule set (`R-SEC-*`, `R-INF-*`, `R-FLOW-01…12`, `R-SCH-01…07`, `R-SES-01…05`, `R-REL-01…06`, `R-TONE-01…03`) and the complete reference-scenario table `S-01`…`S-15`.

Consequence: **no spec reconstruction was needed and none was written.** `docs/work/2026-10-22-audit/behavior-spec-reconstructed.md` deliberately does not exist. Section 3 below is judged against the real spec, with real rule IDs and real scenario IDs. Earlier searches missed the file because they looked under `docs/` and because the file is untracked, so `git grep` and `git ls-files` do not see it. This is recorded as finding **F-01**.

---

## 1. Pipeline map

Legend for the decision column: **D** = deterministic backend code, **L** = the LLM, **D←L** = the LLM proposes and the backend may override or discard.

| # | Hop | File · main functions | Input | Output | Who decides |
|---|---|---|---|---|---|
| 1 | WhatsApp webhook | `src/routes/whatsapp/webhook-whatsapp.ts` · `webhookWhatsApp` POST handler, `claimWhatsAppWebhookEvent` (L52), `recoverStaleProcessingWebhookEvents` (L33) | Meta JSON + `x-hub-signature-256` | row in `whatsapp_webhook_events`, row in `messages` (text only), row in `autonomous_tasks` | **D**. HMAC check (L279), dedup by `externalId` with `onConflictDoNothing` (L87), 60 s lease (L30) |
| 2 | Lead + conversation resolution | same file L344–L368 · `leadIngestionService.ingest` | phone, WhatsApp profile name | `leads` row, **first** `conversations` row with `status='active'` | **D**. `.limit(1)` on an unordered query (L352–361); no inactivity check, no 24 h rotation |
| 3 | Button routing | same file L375–L413 | `interactive.button_reply.id` | task type by prefix: `pref:` → preference reply, `consultant:` → selection, `confirm:`/`cancel:` → button reply, bare UUID → `send_confirmation_request` | **D**. Button taps are **never written to `messages`** |
| 4 | Dedup / batching | `src/services/conversations/inbound-message-batch.ts` · `selectInboundMessageBatch`, `getInboundBatchCutoffAt`, `buildInboundReplyIdempotencyKey`; `webhook-whatsapp.ts:179` `extendOpenInboundBatch` | pending `process_inbound_message` tasks for the conversation | one anchor task owning a cohort of unprocessed user messages | **D**. Debounce = `MESSAGE_DEBOUNCE_MS`, default **15 000 ms** (`src/env.ts:34`) |
| 5 | Task executor | `src/services/conversations/autonomous-task-executor.ts` · `claimNextTask` (L59), `executeNextAutonomousTask` (L280), `recoverStaleAutonomousTasks`, `PermanentAutonomousTaskError` (L257) | `autonomous_tasks` | handler invocation under a lease token | **D**. `NOT EXISTS` clause serialises per conversation (L80–L93); retry with `computeRetryBackoffMs` until `maxAttempts` |
| 6 | Handlers | `src/services/conversations/autonomous-task-handlers.ts` · `handleProcessInboundMessage` (L102), `handleProcessButtonReply` (L239), `handleSendConsultantPreferenceQuestion` (L398), `handleProcessConsultantPreferenceReply` (L505), `handleProcessConsultantSelection`, `handleSendConfirmationRequest` (L856) | task row | outbox row(s), session stage transitions | **D** |
| 7 | Turn orchestration | `src/services/conversations/generateMarianaResponse.ts` · `generateMarianaResponse` (L277), `buildMessageHistoryCondition` (L78), `persistAuthorizedAssistantReply` (L217), `formatSchedulingOffer` (L158) | leadId, current message block, cutoff | assistant `messages` row + outbox payload | **D** owns stage, question, status, `interestedInConsultant`; **D←L** owns the prose |
| 8 | Stage machine | `src/services/conversations/conversation-stage.ts` · `computeConversationStage` (L195), `nextQuestion` (L129), `getAskedQuestions` (L116), `reconcileLeadUpdate` (L297), `composeStageReply` (L381) | persisted lead + assistant message texts + has-active-session | `StagePlan {stage, question, questionKey, doNotAsk, askedQuestions}` | **D**. "Already asked" is inferred from **exact backend strings** in history (L66–L79) |
| 9 | Retrieval + policy | `src/ai/knowledge/retrieve.ts` · `retrieveKnowledge` (L61), `formatKnowledgeContext` (L115); `src/ai/knowledge/commercial-policy.ts` · `resolveCommercialAccess` (L172) | the current user block, joined | evidence list + access level 1/2/3 | **D**. Bag-of-words token overlap, no stemming, no synonyms |
| 10 | Gemini call | `src/ai/agent.ts` · `generateMarianaReply` (L153), `buildConversationContextSection` (L100), `STAGE_GUIDANCE` (L85); `src/ai/client.ts` · `ai` (L13), `GEMINI_RETRY_OPTIONS` (L4) | system instruction + full message contents | `MarianaResponse` JSON | **L** writes `reply`, proposes `nextAction` and `leadUpdate`. **Level 3 short-circuits before the call** (L198–L213) |
| 11 | Validation / sanitising | `src/ai/knowledge/validate-response.ts` · `validateMarianaEvidence` (L61); `src/services/conversations/mariana-safety.ts` · `sanitizeCommercialIdentity` (L45), `assertSafeMarianaReply` (L117), `isGuardrailHit` (L24) | model reply | reply, replaced reply, or a **thrown error** | **D** |
| 12 | Action execution | `src/services/agent/execute-next-action.ts` · `executeNextAction` (L164), `resolveAuthorizedAction` (L102), `hasCurrentSchedulingIntent` (L78), `ACTION_ALIASES` (L37); `src/services/conversations/pending-offer.ts` · `detectPendingOffer` (L24), `acceptsPendingOffer` (L136), `isClearAffirmative` (L107) | model `nextAction`, current messages, lead status | one of 5 authorised actions | **D** overrides **L** |
| 13 | Scheduling | `src/services/calendar/scheduling-offer-service.ts` · `persistOffer` (L57), `enqueueConsultantPreferenceQuestion` (L171); `scheduling-choice-service.ts` · `resolveChoice` (L45); `scheduling-confirmation-service.ts`; `scheduling-confirmation-orchestrator.ts`; `scheduling-cancellation-service.ts`; `scheduling-availability.ts`; `consultant-availability.ts`; `scheduling-session-expiration.ts` | leadId, slots, button ids | `scheduling_sessions` + `scheduling_slots`, stage transitions | **D**. Slot ids validated against the persisted session and `selectedSlotId` |
| 14 | Availability | `src/services/calendar/availability.ts` · `getBusinessHours` (L66), slot loop (L41–L49); `src/integrations/google-calendar/google-calendar-service.ts` (L88, L142, L146) | Google freebusy | 30-minute slots | **D**. **Business hours use server local time**, Calendar writes use `America/Sao_Paulo` |
| 15 | Appointments | `src/services/calendar/appointment-service.ts`; `src/services/appointments/appointment-status.ts` · `CONFIRMED_APPOINTMENT_STATUSES` (L19), `canTransitionAppointmentStatus` (L52) | confirmation | `appointments` row + Google event | **D** |
| 16 | Outbox | `src/services/messaging/outbound-messages.ts` · `enqueueOutboundMessage` (L~70), `executeNextOutboundMessage` (L~410), `recordAcceptedSend`, `recoverStaleOutboundMessages` (L~390); `src/services/conversations/whatsapp-compliance.ts` · `assertWhatsAppOutboundAllowed` (L58), `evaluateWhatsAppOutbound` (L23) | outbox row | state machine `pending → sending → sent / failed / unknown` | **D**. 24 h customer-window gate; `unknown` is never resent |
| 17 | WhatsApp send | `src/integrations/whatsapp/whatsapp-client.ts`, `whatsapp-service.ts`, `whatsapp-errors.ts` | outbox payload (text or buttons) | Graph API call, `WHATSAPP_SEND_TIMEOUT_MS` default 15 000 ms | **D** |
| 18 | Workers | `src/services/reliability/background-workers.ts` · `startReliabilityWorkers` (L28), `drainConversationWork` (L107); `polling-worker.ts` | timer | drains tasks then outbox, 10 per tick | **D**. **Only two workers exist**: autonomous tasks and outbox |

### 1.1 Minimum latency of one reply (arithmetic, estimate)

15 000 ms debounce (`src/env.ts:34`) + up to 2 000 ms task poll (`AUTONOMOUS_TASK_POLL_MS`) + Gemini latency (~1–3 s) + up to 2 000 ms outbox poll (`OUTBOUND_MESSAGE_POLL_MS`) + Graph API (~0.3–1 s) ≈ **20–23 s** from the last client message to delivery, for every single turn. The spec's own scenario `S-12` only asks for a 5-second coalescing window.

---

## 2. LLM reasoning audit

### 2.1 Model and configuration

Everything the model receives in `config` is in `src/ai/agent.ts:240–248`:

```ts
const response = await ai.models.generateContent({
	config: {
		responseJsonSchema: z.toJSONSchema(marianaResponseSchema),
		responseMimeType: "application/json",
		systemInstruction: contextualSystemPrompt,
	},
	contents,
	model: MODEL,          // "gemini-3.5-flash-lite", src/ai/agent.ts:36
});
```

| Setting | Value in code | Comment |
|---|---|---|
| Model | `gemini-3.5-flash-lite` (`src/ai/agent.ts:36`), hard-coded constant, not an env var | **Lite tier.** The cheapest, fastest, least capable tier of the family |
| Thinking / reasoning | **not set at all** | No `thinkingConfig`, no `thinkingBudget`, no `thinkingLevel` anywhere in `src/` (`grep` over the whole tree returns nothing). The model runs at its default reasoning setting, which on a `*-flash-lite` tier is the minimum |
| Temperature | **not set** | Provider default (~1.0 for Gemini). High randomness is exactly wrong for a flow that must be repeatable |
| `topP` / `topK` | **not set** | — |
| `maxOutputTokens` | **not set** | — |
| `candidateCount` | **not set** | — |
| Safety settings | **not set** | — |
| Structured output | `responseMimeType: "application/json"` + `responseJsonSchema` from Zod | See 2.1.2 |
| Retries | `src/ai/client.ts:4–11`: 3 attempts, exp base 2, initial 0.5 s, max 4 s, jitter 1, on 408/429/500/502/503/504 | **404 is not retried**, which is correct, but it means a wrong model name is an instant client-facing failure |
| Timeout | none | No `AbortSignal`, no deadline. Only WhatsApp sends have a timeout (`WHATSAPP_SEND_TIMEOUT_MS`) |
| Observability | **none** | Section 2.4 |

**This is the single most direct answer to "Mariana doesn't reason": the code never asks her to.** A lite tier with no thinking budget, no temperature control and a 5.6k-token rule sheet is configured for cheap one-shot text completion, not for multi-constraint reasoning.

#### 2.1.1 Model-name churn (N6)

`git log` shows `e05be8d fix: revert model version to gemini-3.5-flash-lite`. The snapshot records the cost of that churn: 14 failures on `models/gemini-3.6-flash-lite not found` (404) plus 4 on `gemini-2.5-flash no longer available` — **19 `process_inbound_message` failures on Oct 13–14, each one a client who never got an answer** (R-REL-05). Root causes:

1. the model id is a source constant (`src/ai/agent.ts:36`), so changing it requires a deploy and there is no way to roll back by configuration;
2. there is no startup validation that the configured model exists;
3. a 404 from the model is treated like any other task failure, so the client is simply left silent instead of getting a fallback message.

#### 2.1.2 Structured-output strictness

`src/ai/schemas/mariana-response-schema.ts` is loose in ways that matter:

- `extractedData: z.record(z.string(), z.any()).optional()` (L39) — an open map. `z.toJSONSchema` turns this into unconstrained `additionalProperties`, which weakens the whole schema and invites the model to spend output tokens on a field nobody reads.
- `nextAction` is a `z.union` of two enums with `.default()` (L55–57). A JSON Schema generated from a union of enums plus a default is the least reliable shape for provider-side constrained decoding.
- `leadUpdate.status: marianaLeadStatus` (L50) is **required** — the model is forced to emit a lead status on every turn, while `src/ai/prompt.ts:90` tells it "você não decide o status" and `reconcileLeadUpdate` (`conversation-stage.ts:308–312`) throws that field away immediately. Pure contradiction, and wasted tokens.
- `evidenceUsed: z.array(z.string().min(1)).optional()` (L38) — free-form strings. If the model invents an id, `validateMarianaEvidence` **throws** (`validate-response.ts:76–80`), which kills the task and leaves the client with no reply. The valid id set is never enumerated in the schema, only described in prose at `prompt.ts:383`.

#### 2.1.3 Tier comparison (documentation knowledge only — no API calls; all figures are ESTIMATES)

| Option | Quality for this load | Cost (estimate) | Latency (estimate) | Verdict |
|---|---|---|---|---|
| **A. `gemini-3.5-flash-lite`, as today (no thinking)** | Poor. Must hold ~15 k chars of rules, pick a stage-appropriate register, avoid 20 forbidden behaviours and emit valid JSON in one forward pass | Lowest. Roughly US$0.0005–0.002 per turn at ~6 k input / ~200 output tokens | ~0.5–1.5 s | Current. Cheapest and the proximate cause of the complaint |
| **B. same lite model + explicit low/medium thinking budget + `temperature ≈ 0.3` + `maxOutputTokens ≈ 400`** | Noticeably better: determinism from low temperature, and a reasoning budget to actually weigh the rules | ~1.5–3× option A (thinking tokens are billed as output) | +0.5–2 s | **Cheapest meaningful experiment. Try this first.** It is a config change, not a redesign |
| **C. `gemini-3.5-flash` (mid tier) + explicit thinking + `temperature ≈ 0.3`** | Good. The right tier for "follow a long policy, choose a register, stay factual" | ~5–15× option A | +1–3 s | **Recommended steady state** for the conversational turn |
| **D. mid/pro tier for everything** | Best, and unnecessary | ~20–40× option A | +2–6 s | Over-spending. Most turns are trivially short |
| **E. split by difficulty** | Lite for greeting/name/slot-confirmation turns; mid tier with thinking for info/objection/sensitive turns | ~2–4× option A | mixed | **Best quality-per-real** once B/C has settled. Needs the stage to drive model choice |

Caveat the owner should hold me to: a 20-second end-to-end latency budget (§1.1) already dominates everything here. Spending an extra 1–2 s on reasoning is invisible to the client, so the latency argument for the lite tier is void. The debounce, not the model, is what makes Mariana feel slow.

### 2.2 The context given to the model

#### 2.2.1 Size (measured)

Measured with a read-only script over `src/ai/*` only, `DATABASE_URL` unset. Token figures use ~3.3 chars/token for Brazilian Portuguese and are **estimates**.

| Block | Chars | Words | ~Tokens |
|---|---|---|---|
| `src/ai/prompt.ts` system prompt, no company configured | 15 389 | 2 297 | ~4 660 |
| `src/ai/prompt.ts` with `companyName: "Ademicon"` | 15 088 | 2 259 | ~4 570 |
| `buildConversationContextSection` (typical turn) | 1 543 | 253 | ~470 |
| Knowledge block (typical hit on "como funciona o consórcio") | 1 528 | 187 | ~460 |
| **Total `systemInstruction`** | **~18 400** | — | **~5 580** |

So roughly **90 % of the system instruction is rules and prohibitions, and ~8 % is the authorised facts she is supposed to answer with.** Add the full message history on top (`agent.ts:162–173` sends every non-system message of the conversation with no window and no truncation). The 15-section prompt contains 14 sections of policy and one short "FLUXO OBJETIVO".

#### 2.2.2 Contradictions in the context (file:line on both sides)

| # | Side A | Side B | Effect |
|---|---|---|---|
| C1 | `prompt.ts:316–317`: "4. INFORMAÇÕES: responda dúvidas gerais … 5. CONSULTOR: **assim que o motivo estiver claro**, ofereça conversar com um consultor" | `MARIANA_BEHAVIOR_SPEC.md` R-FLOW-03: "A oferta de consultor só vem **depois de pelo menos uma resposta informativa**" | The prompt authorises the exact behaviour the spec forbids. The stage machine implements the prompt, not the spec. **This is the owner's symptom #1.** |
| C2 | `prompt.ts:60`: "Você não escreve, por conta própria, ofertas de reunião"; `prompt.ts:92`: "Você nunca escreve a oferta do consultor nem perguntas de qualificação" | `prompt.ts:317`: "**ofereça** conversar com um consultor usando exatamente a pergunta fornecida pela aplicação"; `agent.ts:89` (`STAGE_GUIDANCE.consultant_offer`): "a aplicação acrescenta a oferta" | "Never write the offer" vs "make the offer". The model is told both in one instruction |
| C3 | `prompt.ts:271`: "Respostas curtas: no máximo 3 frases" | `agent.ts:112`: "escreva no máximo **2** frases curtas"; `conversation-stage.ts:419`: `maxStatements = question ? MAX_SENTENCES - 1 : MAX_SENTENCES` | Three different caps (3 / 2 / 2-or-3) for the same thing |
| C4 | `prompt.ts:269`: "Faça no máximo uma pergunta por mensagem" | `conversation-stage.ts:394–398`: **every** sentence ending in `?` is deleted | The model is told it may ask one question; the backend deletes all of them. The budget it is given does not exist |
| C5 | `agent.ts:149`: 'Se o cliente perguntar "o que você me indica?" … dê uma explicação breve e geral' | `commercial-policy.ts:131–142`: `"recomenda"`, `"indica para mim"` → **level 3**, and `agent.ts:198–213` returns `COMMERCIAL_HANDOFF` **without calling the model** | Verified: `"o que voce recomenda?"` → level 3. The instruction is unreachable code from the model's point of view |
| C6 | `prompt.ts:182`: "A reunião padrão possui duração de 30 minutos" | `commercial-policy.ts:95–105`: `"quanto tempo"` → **level 3** | Verified: `"quanto tempo dura a reuniao?"` → level 3 handoff. The model holds the answer and is never allowed to give it |
| C7 | `prompt.ts:326` and spec R-INF-04: a value the client states is information, not a simulation request | `commercial-policy.ts:16–31`: `isSpecificAmountQuestion` = any digit + one of `taxa|parcela|carta|lance|grupo|simul` → level 3 | Verified: `"tenho 2 carros e quero uma carta"` → level 3 handoff. **Violates R-INF-04 / `S-05`** |
| C8 | `prompt.ts:188–200`, `agent.ts:97`: never invent or promise a time | `generateMarianaResponse.ts:654`: on an authorised offer the model's reply is **thrown away** and replaced by `formatSchedulingOffer(...)` | The model is punished for a behaviour it is also prevented from having. Its output on offer turns is irrelevant |
| C9 | `prompt.ts:90`: "você não decide o status nem o interesse no consultor" | `mariana-response-schema.ts:50`: `leadUpdate.status` is **required**; `L45`: `interestedInConsultant` is offered as a field | The schema demands exactly what the prompt forbids. Both are discarded at `conversation-stage.ts:308–312` |
| C10 | `prompt.ts:204`, `prompt.ts:227`: after a confirmed booking, "o atendimento … deve ser encerrado" | Spec R-SES-05: with a future appointment, "**não encerrar a conversa a cada mensagem**", answer questions normally | The prompt tells her to shut down; the spec tells her to keep helping |
| C11 | `prompt.ts:19` (no company configured): "NÃO representa nominalmente nenhuma administradora" | `src/ai/knowledge/ademicon.ts`: an entire Ademicon corpus, `commercial-policy.ts` mentions Ademicon, `mariana-safety.ts:51–72` scrubs "Ademicon" out of replies | The knowledge base is Ademicon's; the identity rules deny Ademicon. `retrieve.ts:77–85` then filters every `companyName`-tagged item out when no company is configured, so most of the corpus is silently unreachable by default |

#### 2.2.3 What the model knows, and does not know, each turn

| Fact | In the prompt? | Where |
|---|---|---|
| Full message history of the conversation | **Yes, unwindowed** | `agent.ts:162–173`. No cap, no summarisation, no truncation |
| Current stage name + one sentence of guidance | Yes | `agent.ts:131` + `STAGE_GUIDANCE` (L85–98) |
| The exact question the backend will append | Yes | `agent.ts:111–113` |
| Fields already known / already asked | Yes | `agent.ts:115–121`, from `buildDoNotAsk` (`conversation-stage.ts:170`) |
| Pending consultant offer marker | Yes | `agent.ts:123–126` |
| Lead name, objective, consortium type, pain point, urgency, current situation, commercial approach, status | Yes | `agent.ts:227–236` |
| Retrieved knowledge | Yes, when retrieval hits | `agent.ts:223–225` |
| **Whether a scheduling session is active** | **No** | `hasActiveSchedulingSession` is computed at `generateMarianaResponse.ts:382–393` and used only to pick the stage. The boolean never reaches the prompt |
| **The scheduling `workflowStage`** (`awaiting_consultant_preference` / `awaiting_slot_selection` / `awaiting_confirmation`) | **No** | Never read outside the handlers |
| **The offered slots, the selected slot, the session expiry** | **No** | `scheduling_slots` / `selectedSlotId` / `expiresAt` are never put in the prompt |
| **Appointment date, time, consultant, Meet link** | **No** | Only existence is checked (`generateMarianaResponse.ts:481–492`), and only to gate a status transition |
| **That the client tapped a button, and which one** | **No** | Button replies are never written to `messages` (`webhook-whatsapp.ts:375–413`), so they are invisible to history and to the model |
| Commercial access level / why a handoff fired | No | `resolveCommercialAccess` result only gates the call |

**This table is the owner's symptom #4 ("she does not know the scheduling state") in full.** During scheduling the model is given the single word `scheduling` and the sentence "a aplicação apresenta os horários" (`agent.ts:96–97`) and nothing else. It cannot answer `S-09` ("está confirmada?") because it is not told what state the booking is in, and it never sees the button taps that moved it.

#### 2.2.4 Does data from old or closed conversations leak into the prompt?

**Traced, and the naive hypothesis is REFUTED while a worse one is CONFIRMED.**

- `buildMessageHistoryCondition` (`generateMarianaResponse.ts:78–106`) always ANDs `eq(messages.conversationId, conversationId)`. The cutoff only bounds time **within** that conversation. `src/tests/message-history-cutoff.test.ts:13–38` pins exactly this: with block ids there are 4 params, without them 2, and the conversation column is always present. So there is **no cross-conversation query leak**.
- The real leak is upstream: `webhook-whatsapp.ts:352–361` takes the first `conversations` row with `status='active'`, and **nothing ever closes a conversation for inactivity** (§5, N2: 329 active conversations, all idle > 24 h; `background-workers.ts:28–91` starts only the task worker and the outbox worker). A conversation therefore lives forever, so one single `conversationId` accumulates weeks of history, and every turn resends all of it.
- `isFirstContact = assistantHistory.length === 0` (`generateMarianaResponse.ts:376`) and `stage = assistantHistory.length === 0 ? "greeting" : …` (`conversation-stage.ts:224`) are both computed from that unbounded history, so a returning client after a week is never a first contact and the conversation never restarts at `greeting`.
- `getAskedQuestions` (`conversation-stage.ts:116–127`) scans that same unbounded history for exact backend strings, so a question asked three weeks ago still counts as asked today and is never asked again.

Net effect: R-SES-02 is not implemented at all, and because of that, old state does leak into what is effectively a new conversation. Symptom #5 confirmed, root cause located in the *absence* of a closer, not in the history query.

### 2.3 Output rewriting layers — every place the model's reply can be replaced, truncated or rewritten

Eleven layers, in execution order. "Reaches the client" is what the client actually sees.

| # | Layer | File:line | Trigger condition | What reaches the client |
|---|---|---|---|---|
| L0 | Level-3 short-circuit | `agent.ts:198–213` | `resolveCommercialAccess` returns level 3 | `COMMERCIAL_HANDOFF`, a fixed 2-sentence string. **The model is never called.** |
| L1 | `sanitizeCommercialIdentity` | `agent.ts:268`, `mariana-safety.ts:45–75` | company is not `"ademicon"` and the reply contains a known Ademicon phrase | reply with those phrases rewritten ("loja Ademicon" → "unidade presencial") |
| L2 | `validateMarianaEvidence` — **throw** | `validate-response.ts:76–80` | `evidenceUsed` contains an id not in the retrieval result | **Exception.** Task fails, retries, eventually `failed`. **Client gets nothing** |
| L3 | `validateMarianaEvidence` — replace | `validate-response.ts:101–114` | level-2 violation, or an unsupported claim with no evidence, or a specific question with no evidence | `COMMERCIAL_HANDOFF`, plus `nextAction` forced to `request_consultant` |
| L4 | `assertSafeMarianaReply` — **throw** | `agent.ts:282`, `mariana-safety.ts:117–130` | any of 13 `FORBIDDEN_PATTERNS`, or an unauthorised company mention | **Exception. Client gets nothing.** Note `mariana-safety.ts:12`: `/\b(carta\|grupo\|lance\|estrategia)\b.{0,30}\b(ideal\|melhor\|certo\|adequado)\b/` fires on an innocent "qual grupo é melhor para você depende do contrato" |
| L5 | `request_consultant` override | `generateMarianaResponse.ts:589–591` | resolved action is `request_consultant` | `COMMERCIAL_HANDOFF`, model reply discarded entirely |
| L6 | `composeStageReply` — drop questions | `conversation-stage.ts:394–398` | **always**: every sentence ending in `?` is deleted | reply minus all its questions |
| L7 | `composeStageReply` — drop greetings | `conversation-stage.ts:396–397`, pattern L366–367 | not first contact **and** the sentence matches `^(ola\|oi\|opa\|bom dia\|boa tarde\|boa noite)\b[^.!?]{0,40}[.!?]?$` | greeting removed — **but only if ≤ 40 chars and starting with one of those six tokens** |
| L8 | `composeStageReply` — sentence cap | `conversation-stage.ts:419–423` | always | at most 2 model sentences when a backend question is appended, 3 otherwise |
| L9 | `composeStageReply` — neutral fallback | `conversation-stage.ts:411–417`, texts at `qualification-gaps.ts:35–38` | nothing survived L6–L8, or only an apology did, and there is no backend question | `"Fico à disposição para qualquer dúvida sobre consórcio."` / `"Se quiser saber mais sobre consórcio, é só me perguntar."` |
| L10 | `persistAuthorizedAssistantReply` | `generateMarianaResponse.ts:239–254` | scheduling not authorised **and** (`nextAction` requests scheduling **or** `hasSchedulingCommitment(reply)` matches one of 6 regexes at L188–195) | `COMMERCIAL_HANDOFF` or `fallbackReply` (itself `composeStageReply` with an empty model reply, L596–599) or `DEFAULT_FALLBACK_REPLY` |
| L11 | Slot-offer replacement | `generateMarianaResponse.ts:654`, `scheduling-offer-service.ts:139–149`, `autonomous-task-handlers.ts:200–208` | `shouldOfferSlots` is true | `formatSchedulingOffer(...)` / `buildWhatsAppSchedulingOffer(...)`. The model's reply is overwritten **in the `messages` row too**, destroying the record of what she actually wrote |

#### 2.3.1 Measured behaviour of these layers

Run read-only against `src/services/conversations/conversation-stage.ts` (no DB, no network):

```
IN : "O consórcio reúne pessoas em um grupo com contribuições mensais. A contemplação acontece por sorteio ou lance. Quer que eu detalhe o sorteio?"
OUT: "O consórcio reúne pessoas em um grupo com contribuições mensais. A contemplação acontece por sorteio ou lance."

IN : "Você prefere um carro novo ou usado?"
OUT: "Fico à disposição para qualquer dúvida sobre consórcio."          <- whole reply replaced by boilerplate

IN : "Essa é uma questão específica da operação e precisa ser analisada por um consultor. Você quer que eu procure um horário para conversar com um consultor?"
OUT: "Essa é uma questão específica da operação e precisa ser analisada por um consultor."   <- the offer is deleted: dead end

IN : "O consórcio reúne pessoas em um grupo. As contribuições são mensais. A contemplação ocorre por sorteio ou lance."
OUT: "O consórcio reúne pessoas em um grupo. As contribuições são mensais. Você quer que eu procure um horário para conversar com um consultor?"   <- 3rd fact dropped to fit the offer
```

Greeting filter (L7), same method:

```
IN : "Olá, Davi! Que bom falar com você de novo por aqui hoje. O consórcio funciona em grupo."
OUT: "Que bom falar com você de novo por aqui hoje. O consórcio funciona em grupo."          <- removed

IN : "Bom dia, Davi, que bom ter você de volta aqui na nossa conversa. O consórcio funciona em grupo."
OUT: "Bom dia, Davi, que bom ter você de volta aqui na nossa conversa. O consórcio funciona em grupo."   <- LEAKS (62 chars > 40)

IN : "Seja bem-vindo de volta! O consórcio funciona em grupo."
OUT: "Seja bem-vindo de volta! O consórcio funciona em grupo."                               <- LEAKS (no listed token)
```

That is the mechanism behind N7's **13 bot replies starting with a greeting**: the filter only catches short greetings that begin with one of six exact tokens, and `temperature` is unset so the model's phrasing varies freely between turns. R-FLOW-02 violated.

#### 2.3.2 How often does the client get boilerplate instead of model reasoning? (ESTIMATE — show the arithmetic)

Inputs, all from the snapshot's real-lead data (N7) and the code paths above:

- Davi: 55 bot replies across 7 conversations.
- Known repeated fixed texts in N7: `COMMERCIAL_HANDOFF` ("Essa é uma questão específica…") **5×** — layer L0/L3/L5, model either not called or fully discarded. `CONSULTANT_OFFER_TEXT` ("Você gostaria de conversar com um consultor…") **5×** — layer L8/L9 appended text; note that the offer text is also embedded inside `COMMERCIAL_HANDOFF` (`commercial-policy.ts:211`), so these two counts partly describe the same messages. `DEFAULT_FALLBACK_REPLY` / neutral fallback ("Posso ajudar com suas dúvidas…") **3×** — layer L9/L10, model reply fully discarded. Objective question **2×** — backend-owned text.

Lower bound on fully backend-authored replies: 5 handoffs + 3 fallbacks + 2 objective questions = **10 of 55 ≈ 18 %** where the client received *zero* model prose. Add the 5 offer-bearing replies, where the model was capped to 2 sentences and had every question deleted, and **~15 of 55 ≈ 27 %** of replies were either entirely or mostly backend boilerplate.

Upper bound, counting every reply mutilated by at least one layer: layers L6, L7 and L8 run on **100 %** of non-handoff replies unconditionally. So **every single reply** is rewritten, and between **18 % and 27 %** contain no model reasoning at all. On top of that, every offer turn (layer L11) discards the model's text entirely and overwrites it in the database.

**These are estimates.** They cannot be made exact, because — see next — the raw model reply is never recorded anywhere, so no one can diff it against what was sent. Labelled as an estimate deliberately.

#### 2.3.3 There is no logging of the model reply vs the sent text

Verified by grep over `src/` excluding tests: `src/ai/` contains **no** `console.*`, no logger import and no log call of any kind; `generateMarianaResponse.ts` likewise. `rawText` (`agent.ts:250`) is parsed and dropped. `metadata {latencyMs, model, usage}` is returned up the stack (`agent.ts:284–290`) and then **never persisted or logged by any caller**. The only structured logs in the whole decision path are `executeNextAction`'s `agent_action_started` / `agent_action_executed` / `agent_action_blocked` lines (`execute-next-action.ts:205, 214, 243, …`) — which is precisely why `no_active_session_or_invalid_stage` is the one failure mode the owner could actually see in N7.

Consequence: nobody — not the owner, not this audit — can answer "did the model reason badly, or did we delete its reasoning?" from production data. Every quality claim about Mariana today is unfalsifiable.

**Proposed logging design (concrete):**

- **Where.** One new module `src/lib/turn-trace.ts` exposing `logTurnTrace(trace)`, called once at the end of `generateMarianaResponse` (after `composeStageReply` and `persistAuthorizedAssistantReply`, inside the same function so it sees both ends) and once in the `catch` path that today loses the turn silently. Use the existing `src/lib/logger.ts` pino instance, at `info`, with `event: "mariana_turn"`.
- **What (one JSON object per turn).** `conversationId`, `leadId` (ids only), `turnId` = the anchor task id, `model`, `latencyMs`, `usage.promptTokens`, `usage.candidatesTokens`, `usage.thoughtsTokens`; `stage`, `questionKey`, `doNotAskCount`, `pendingOffer`, `hasActiveSchedulingSession`, `schedulingWorkflowStage`; `commercialAccess.level` and `.reason`; `retrieval.evidenceFound`, `retrieval.ids[]`, `retrieval.relevance[]`; `model.nextAction` and `resolvedAction`; **`rawReplyHash`** (SHA-256) plus **`rawReplyLength`**, **`sentReplyHash`**, **`sentReplyLength`**; and a `rewrites: string[]` array naming each layer that fired (`"L6_dropped_questions"`, `"L9_neutral_fallback"`, `"L11_slot_offer_replaced"`, …) with counts (`questionsDropped: 2`, `sentencesTruncated: 1`).
- **PII.** Never log the message bodies at `info`. Log hashes and lengths plus the rewrite labels — that alone answers "was the reasoning deleted?" for every turn. Put the **full raw reply and the full sent text behind a `TURN_TRACE_VERBOSE=true` env flag**, off in production by default, and when on, log them at `debug` with the phone number redacted to its last 4 digits (`R-SEC-03` already forbids a full phone without need). Never log the system prompt, the knowledge contents, tokens or OAuth codes (`R-SEC-01`, `R-SEC-03`).
- **Retention.** Operational logs 7–14 days. If a durable table is wanted later, store only the non-PII fields plus hashes and keep 90 days; the message bodies already live in `messages` under the existing retention, so do not duplicate them.
- **Why it is step zero.** Without this, every other fix in this report is measured by anecdote.

### 2.4 Decision-ownership conflicts

Four independent deciders can rule on the same turn: (1) the LLM's `nextAction`; (2) the stage machine `computeConversationStage` / `nextQuestion`; (3) the regex intent detectors `hasCurrentSchedulingIntent`, `acceptsPendingOffer`, `resolveCommercialAccess`; (4) `isLeadQualified` plus the `executeNextAction` gates. They disagree, and the disagreements are not reconciled — they are resolved by whichever code runs last.

| Input (client turn) | LLM concludes | Stage machine concludes | Regex detectors conclude | Qualification gate | What the client receives | Rule |
|---|---|---|---|---|---|---|
| `"oi"` → name → `"quero um carro novo"` | likely `answer_basic_question` | **`consultant_offer`**, question = `CONSULTANT_OFFER_TEXT` (measured: `nextQuestion` L155 fires the moment `objective` is non-empty) | no intent | `qualifying` | ≤2 model sentences **+ the consultant offer**, with no explanation first | **R-FLOW-03 violated** (`S-01`, `S-02`) |
| `"como funciona?"` (bare) | wants to explain | `info` | level 1 | — | retrieval returns **0 items** (measured), so the prompt says "Nenhuma evidência autorizada… encaminhe ao consultor" → a vague non-answer or a handoff | **R-FLOW-03, R-FLOW-11 violated** (`S-02`) |
| `"quanto tempo dura a reuniao?"` | knows: 30 min (`prompt.ts:182`) | `info` | **level 3** (measured) | — | `COMMERCIAL_HANDOFF`. Model never called | **R-FLOW-11, R-SCH-05 violated** |
| `"o que voce recomenda?"` | `agent.ts:149` tells it to explain briefly | `info` | **level 3** (measured) | — | `COMMERCIAL_HANDOFF` | **C5, R-FLOW-11** |
| `"tenho 2 carros e quero uma carta"` | would record it (`R-INF-04`) | `info` | **level 3** (measured) | — | `COMMERCIAL_HANDOFF` instead of registering the information | **R-INF-04 violated** (`S-05`) |
| `"qual a disponibilidade de horarios?"` | `offer_meeting` | `consultant_offer`/`info` | level 3, **and `hasCurrentSchedulingIntent` = false** (the patterns need `quais`, not `qual`) | — | `COMMERCIAL_HANDOFF` with the offer sentence then deleted by layer L6 → **pure dead end** | **R-FLOW-11, R-SCH-05 violated** |
| `"sim"` right after the offer | `offer_meeting` | `scheduling` | `acceptsPendingOffer` = true | now `qualified` | slot buttons **and then** the consultant-preference buttons — two competing sets | **R-SCH-01 violated** (N7 Fábio) |
| **Tap on a slot button** after both sets were sent | never consulted (button taps never reach the model) | never consulted | n/a | n/a | session is at `awaiting_consultant_preference`, handler requires `awaiting_slot_selection` → `{skipped:true, reason:"no_active_session_or_invalid_stage"}` (`autonomous-task-handlers.ts:912`) and **nothing is enqueued** | **R-SCH-03 violated** (N7 Fábio) |
| `"está confirmada?"` mid-scheduling | has no state to answer with | `scheduling`, `question = null` | retrieval accidentally matches `consorcio-credito-procedimentos` on the stop-word `"esta"` → **level 2** (measured) | — | a generic commercial reply, or the neutral fallback; no state, no buttons | **R-SCH-05 violated** (`S-09`, N7 Fábio) |
| `"sim, mas antes me explica"` after the offer | `answer_basic_question` | `scheduling` if already interested | `isClearAffirmative` = false (`"mas"` is in `NEGATION_OR_DEFERRAL_PATTERN`, `pending-offer.ts:47`) | — | correct here, but the same rule silently rejects `"sim, pode ser depois das 14h"` | R-FLOW-10 OK, usability risk |
| Lead `status='scheduled'` with only a **past** appointment | n/a | **`confirmation`** forever (`conversation-stage.ts:210–217`, measured) | n/a | `LEAD_STATUS_TRANSITIONS.scheduled = ["scheduled"]` — **terminal** | "o agendamento já foi confirmado", no new questions, forever | **R-SES-04 violated** (N4) |

Two structural observations:

1. **The LLM's `nextAction` is almost decorative.** `resolveAuthorizedAction` (`execute-next-action.ts:102–121`) overrides it from the regex signals, and the gates at L242–L270 and L286–L314 can downgrade anything to `continue_qualification`. That is correct per the `CLAUDE.md` invariant "the AI is never the authority on IDs, availability or authorization" — but the model is still asked to produce the field on every turn (schema L55–57), spending tokens and attention on a decision that is thrown away.
2. **Nothing owns "has she explained yet?"** No decider tracks it. `getAskedQuestions` tracks which *questions* were asked; no counterpart tracks whether an *informative answer* was given. R-FLOW-03 is therefore not merely buggy — it is **unrepresentable** in the current state model.

### 2.5 Knowledge base

`retrieveKnowledge` (`retrieve.ts:61–113`) is a bag-of-words scorer: normalise, strip accents, drop tokens shorter than 3 chars and a 20-word stop list (L9–L30), then `relevance = |query tokens ∩ (content ∪ keywords) tokens|`, keep `relevance > 0`, sort by relevance then id. **No stemming, no lemmatisation, no synonyms, no embeddings, no minimum score, no cap on the number of items returned.** The corpus is 3 files: `ademicon.ts`, `products.ts` (4 client-visible items), `consorcio.ts` (7 items), plus 2 items in `index.ts` — about **20 items total**, of which the `companyName: "Ademicon"` ones are filtered out entirely when no company is configured (L77–85).

Measured (read-only script, `src/ai/knowledge/*` only, `DATABASE_URL` unset, no network):

```
[level 1] evidence=true  n=4 ids=consorcio-como-funciona:1,consorcio-contemplacao-sem-previsao:1,
                                produto-imobiliario-finalidades:1,produto-servicos-finalidades:1
          <= "como funciona o consórcio para carro"
[level 1] evidence=false n=0  <= "quero um carro novo"
[level 1] evidence=false n=0  <= "como funciona?"
[level 1] evidence=false n=0  <= "me explica como funciona"
[level 1] evidence=false n=0  <= "quero comprar um apartamento, como funciona"
[level 1] evidence=false n=0  <= "é melhor que financiamento?"
[level 1] evidence=true  n=4  <= "o que é consórcio"
[level 2] evidence=true  n=4  <= "como funciona o lance"
[level 3] evidence=false n=0  <= "quanto fica a parcela"
[level 2] evidence=true  n=1 ids=consorcio-credito-procedimentos:1  <= "está confirmada?"
[level 1] evidence=true  n=1 ids=consorcio-carta-de-credito:1       <= "tem horário disponível amanhã?"
[level 1] evidence=false n=0  <= "oi"
```

So, answering the brief's exact question: **"como funciona o consórcio para carro" does return content — but the wrong content.** It returns the generic item, the no-forecast item, and then the **imobiliário** and **serviços** product items, while `produto-veiculos-tipos` is **never returned**. Reason: the word **"carro" appears nowhere in the corpus** — the vehicle item's keywords are `veiculos, caminhoes, carrocerias, maquinario, agricolas` (`products.ts:65–71`). Every item scored `relevance: 1`, all on the single shared token `consorcio`, so the ranking is arbitrary and the model is handed property and services facts in answer to a car question.

Gaps, in severity order:

1. **No stemming or synonyms.** `carro`↛`veiculo`, `apartamento`↛`imovel`, `comprar`↛`compra`. Common Brazilian vocabulary misses entirely.
2. **The most common follow-up question in the whole flow — a bare `"como funciona?"` — retrieves zero evidence** (0 items), and `formatKnowledgeContext` (L118–120) then injects: *"Nenhuma evidência autorizada foi encontrada para a pergunta atual. Não afirme o fato comercial e encaminhe a questão ao consultor…"*. The prompt is literally ordering a handoff for the question Mariana exists to answer. **This, together with C1, is the mechanism of the owner's symptom #1.**
3. **Relevance is an unnormalised raw count** with no threshold, so one incidental token match passes. `"está confirmada?"` matches `consorcio-credito-procedimentos` because the content contains "está sujeita" and **`esta` is not in the stop-word list** (L9–L30) — which escalates a *scheduling* question to commercial **level 2** and injects `LEVEL_TWO_INSTRUCTION`. Pure accident, directly damaging `S-09`.
4. **No comparison content.** `"é melhor que financiamento?"` — one of the two or three questions every consórcio prospect asks — has no corpus item at all.
5. **No scheduling/meeting content.** Duration, format, Meet link, what the consultant does: all absent from the corpus and simultaneously trapped at level 3 (C6).
6. **Half the corpus is unreachable by default.** Every `companyName: "Ademicon"` item is filtered out unless `businessProfile.companyName` is set (L77–85), while `prompt.ts:19` tells the model to deny any administrator affiliation. The knowledge base and the identity policy contradict each other (C11).
7. **No corpus item is tagged to a conversation stage**, so there is no way to retrieve "the 2–3 sentence explanation appropriate for the `info` stage" — which is exactly what R-FLOW-03 requires.

---

## 3. Spec compliance matrix

Judged against the real `MARIANA_BEHAVIOR_SPEC.md` v1.0 (see §0.1). Every row is a real rule ID. No reconstructed rules were used, so no row is marked `spec-gap`.
`N#` = Neon snapshot finding. Evidence without a prefix is `file:line`.

### 3.1 Safety and information

| ID | Status | Evidence | Root cause |
|---|---|---|---|
| R-SEC-01 | OK | `prompt.ts:273–293` + no prompt echo path | — |
| R-SEC-02 | OK | `prompt.ts:113`, `prompt.ts:289` | — |
| R-SEC-03 | PARTIAL | No tokens logged anywhere; `whatsapp-compliance.ts:82–88` logs `leadId` only. But `whatsapp_webhook_events.phone` stores the full number and `payload` stores the whole Meta message | Full phone persisted in the event payload without a need test |
| R-INF-01 | OK | `validate-response.ts:76–114`, `retrieve.ts`, `prompt.ts:371–385` | — |
| R-INF-02 | **VIOLATED** | `COMMERCIAL_HANDOFF` (`commercial-policy.ts:211`) does carry the offer, **but measured: passing it through `composeStageReply` deletes the offer sentence** (layer L6). Also over-triggers: `"quanto tempo dura a reuniao?"`, `"o que voce recomenda?"` → level 3 | Layer L6 deletes any `?` sentence; `isLevelThreeQuestion` keyword list is too broad |
| R-INF-03 | OK | `prompt.ts:139–163`, `mariana-safety.ts:6–21`, `validate-response.ts:12–20` | — |
| R-INF-04 | **VIOLATED** | Measured: `"tenho 2 carros e quero uma carta"` → level 3 handoff. `commercial-policy.ts:16–31` `isSpecificAmountQuestion` | Any digit + `carta\|taxa\|parcela\|lance\|grupo\|simul` is treated as a simulation request |
| R-INF-05 | OK | `lead-qualification.ts:50–61`, `update-lead-from-agent.ts:~318` throws under 18 | — |

### 3.2 Conversation flow

| ID | Status | Evidence | Root cause |
|---|---|---|---|
| R-FLOW-01 | PARTIAL | `conversation-stage.ts:129–168` implements the order, but `nextQuestion` L136–143 jumps to `scheduling` whenever `interestedInConsultant === true`, skipping `info` entirely | No "has informed" state |
| R-FLOW-02 | **VIOLATED** | N7: 13 bot replies start with a greeting. Measured: `GREETING_SENTENCE_PATTERN` (`conversation-stage.ts:366–367`) leaks `"Bom dia, Davi, que bom ter você de volta…"` (62 chars) and `"Seja bem-vindo de volta!"` | 40-char/6-token regex; `temperature` unset so phrasing varies |
| R-FLOW-03 | **VIOLATED** | Measured: objective known → `questionKey: "consultantOffer"` on the very next turn (`conversation-stage.ts:155`). N7 Fábio: offer before any explanation. Contradiction C1 at `prompt.ts:317`. Reinforced by `src/tests/simulation-checks.test.ts:34–48`, which **passes** a transcript that offers on turn 2 | No informative-turn precondition exists in the model or the prompt |
| R-FLOW-04 | OK | `execute-next-action.ts:55–97` + `conversation-stage.ts:136–143` | — |
| R-FLOW-05 | **VIOLATED** | N7: handoff 5×, offer text 5×, "Posso ajudar com suas dúvidas…" 3×, objective question 2× | Fixed texts (L0/L3/L5/L9) bypass `getAskedQuestions`, so repetition is untracked; `getAskedQuestions` matches exact strings only |
| R-FLOW-06 | PARTIAL | Enforced destructively: layer L6 deletes **all** questions, L8 caps sentences. Caps disagree (C3: 3 vs 2 vs 2) | Enforcement by deletion, not by instruction |
| R-FLOW-07 | OK | `inferConsortiumType` (`conversation-stage.ts:241–255`), `buildDoNotAsk` L178–182 | — |
| R-FLOW-08 | OK | `qualification-gaps.ts:12–15`, `lead-qualification.ts:50` | — |
| R-FLOW-09 | OK | `agent.ts:141`, `reconcileLeadUpdate` (`conversation-stage.ts:297`) | — |
| R-FLOW-10 | OK | `pending-offer.ts:24–44`, `136–148`; `execute-next-action.ts:114–119`. Marker is backend text in the previous assistant message, never free text | — (but see F-17: `generateMarianaResponse.ts:654` overwrites the assistant message on offer turns, which can erase a marker) |
| R-FLOW-11 | **VIOLATED** | Measured dead ends: `COMMERCIAL_HANDOFF` loses its offer sentence; `"qual a disponibilidade de horarios?"` → handoff with no next step; a model reply made only of questions → `"Fico à disposição…"`. N7: silent drops. N6: 19 failures = no reply at all | Layers L2/L4 throw; L6 deletes the next step; handlers return `skipped` with no message |
| R-FLOW-12 | **VIOLATED** | Measured: a 1-question reply is replaced wholesale by boilerplate; `generateMarianaResponse.ts:654` overwrites the whole reply on offer turns; L2/L4 discard it by throwing | Design choice recorded in `docs/objective-flow-plan.md` §2.9: "remove every question sentence that Gemini wrote" |

### 3.3 Scheduling

| ID | Status | Evidence | Root cause |
|---|---|---|---|
| R-SCH-01 | **VIOLATED** | `generateMarianaResponse.ts:660–678`: `persistOffer` then `enqueueConsultantPreferenceQuestion` in the same turn; `autonomous-task-handlers.ts:200–208` sends the slot buttons and `L465–L494` sends the preference buttons. N7 Fábio: two competing button sets | Order inverted: slots are built and sent **before** the preference step the spec puts first |
| R-SCH-02 | **VIOLATED** | `availability.ts:86–89`: `start.setHours(8,0,0,0)` / `end.setHours(18,0,0,0)` and `currentDate.getDay()` all use **server local time**, while `google-calendar-service.ts:88,142,146` and `formatSchedulingOffer` use `America/Sao_Paulo` | No timezone in the business-hours computation. On a UTC host, 08:00–18:00 UTC = 05:00–15:00 BRT: pre-dawn slots offered, afternoon slots never offered |
| R-SCH-03 | **VIOLATED** | Six silent exits that enqueue nothing: `autonomous-task-handlers.ts:569`, `776`, `912` (`no_active_session_or_invalid_stage`), `L~580` (`button_from_another_session`), `L~793` (`consultant_not_active`/`consultant_no_slots`), `L~925` (`choiceResult.reason`), `L~975` (`session_changed_before_confirmation`); plus `handleProcessButtonReply` L~297/L~345/L~370, which only enqueue a message when `ok === true`. N5: 16 sessions `active` past `expiresAt`. N7 Fábio: tap ignored | Handlers treat "cannot act" as "nothing to say". No re-offer, no expiry notice, no stage-button resend |
| R-SCH-04 | OK | `scheduling-choice-service.ts:117–144` and `autonomous-task-handlers.ts:~946–962` both require `eq(selectedSlotId, slot.id)` and `gt(expiresAt, now)` in the UPDATE predicate | — (the invariant is correctly enforced) |
| R-SCH-05 | **VIOLATED** | `computeConversationStage` L219–220 returns `stage: "scheduling"`, `question: null`; `STAGE_GUIDANCE.scheduling` (`agent.ts:96`) gives the model no state; session `workflowStage`, slots and `selectedSlotId` never reach the prompt (§2.2.3). Measured: `"está confirmada?"` → accidental level 2. N7 Fábio: generic reply | The model is asked about a state it is not given, and no deterministic answer exists either |
| R-SCH-06 | OK (unverified at runtime) | `scheduling-availability.ts`, `appointment-service.ts`, `AGENDA_OCCUPYING_APPOINTMENT_STATUSES` (`appointment-status.ts:13–17`) | Re-validation exists; not exercised in this read-only audit |
| R-SCH-07 | OK | `updateLeadFromAgent` throws unless `appointmentCreated` (`update-lead-from-agent.ts:~305`); confirmation text is sent only after the orchestrator returns `ok` (`autonomous-task-handlers.ts:~292–305`) | — |

### 3.4 Sessions and memory

| ID | Status | Evidence | Root cause |
|---|---|---|---|
| R-SES-01 | **VIOLATED** | N3: one lead with 2+ active conversations. `webhook-whatsapp.ts:352–368` does a `.limit(1)` read then a separate insert with **no unique index and no transaction**; `src/db/schema/conversations.ts` has no partial unique constraint on `(leadId) WHERE status='active'` | Read-then-insert race, no DB-level guarantee |
| R-SES-02 | **VIOLATED — not implemented at all** | N2: 329 conversations `active`, all idle > 24 h. `background-workers.ts:28–91` starts only `autonomous-task-worker` and `outbound-message-worker`; `grep` finds no inactivity closer anywhere. The only `close` path is the model emitting `nextAction: "close"` (`execute-next-action.ts:329–346`) | The feature does not exist. Hence history, `isFirstContact`, `getAskedQuestions` and `pendingOffer` all accumulate forever (§2.2.4) |
| R-SES-03 | UNKNOWN | Durable fields are reused because the conversation never ends, so the "confirm the old objective in one sentence" behaviour has never been reachable. No code implements it | Blocked by R-SES-02 |
| R-SES-04 | **VIOLATED** | N4: Davi is `scheduled` with only a past appointment. `generateMarianaResponse.ts:481–492` filters appointments by **status only, never by date**; `LEAD_STATUS_TRANSITIONS.scheduled = ["scheduled"]` (`lead-status.ts:17`) makes the status **terminal**; `conversation-stage.ts:210–217` then pins the stage to `confirmation`. Measured: a lead with a past appointment still yields `stage: "confirmation"` | Two independent defects: a date-blind appointment query and a terminal lead status with no recovery edge |
| R-SES-05 | **VIOLATED** | `STAGE_GUIDANCE.confirmation` (`agent.ts:86–87`): "Responda de forma breve, sem novas perguntas comerciais"; `prompt.ts:204–212` orders the conversation shut down. Appointment date/time/consultant are **never** put in the prompt (§2.2.3), so the `S-10` answer is impossible. No reschedule/cancel capture path exists | Contradiction C10 plus missing appointment context |

### 3.5 Reliability

| ID | Status | Evidence | Root cause |
|---|---|---|---|
| R-REL-01 | OK | `inbound-message-batch.ts`, `webhook-whatsapp.ts:449–474`, `extendOpenInboundBatch` L179–221. Cost: 15 s debounce (§1.1) | — |
| R-REL-02 | OK | `claimWhatsAppWebhookEvent` (`webhook-whatsapp.ts:52–127`) with `onConflictDoNothing` on `externalId`; `messages` insert also `onConflictDoNothing` (L423); per-run idempotency keys in every handler | — |
| R-REL-03 | OK | `outbound-messages.ts:289–346`: after Meta accepts, a persistence failure records `unknown`, never `pending`; `recoverStaleOutboundMessages` (L~390–400) moves a stale `sending` to `unknown` without resending | — (invariant correctly enforced) |
| R-REL-04 | OK | `whatsapp-client.ts` + `whatsapp-errors.ts`, `WHATSAPP_SEND_TIMEOUT_MS` (`env.ts:56–61`), commit `52d547c` | — |
| R-REL-05 | **VIOLATED** | N6: 19 `process_inbound_message` failures (14× model 404, 4× model removed, 1× no Google connection) = 19 clients with no reply. 40 failed webhook events, 36 of them "processing lease expired". 2 `probe` tasks "Unsupported autonomous task type". 7 outbound blocked `missing_proactive_consent`. Plus layers L2/L4 throwing. No user-facing fallback exists on any of these paths | A failed task is terminal and silent: `executeNextAutonomousTask` marks `failed` (`autonomous-task-executor.ts:213, 243`) and no one tells the client. No `probe` handler is registered (`createAutonomousTaskHandlers`, `autonomous-task-handlers.ts:1002–1015`) |
| R-REL-06 | OK | `generateMarianaResponse.ts:495–632` single transaction; `autonomous-task-handlers.ts:465–494` and `L~946–990` transition + enqueue atomically (commit `b0a8d72`) | — |

### 3.6 Tone and style

| ID | Status | Evidence | Root cause |
|---|---|---|---|
| R-TONE-01 | OK | `prompt.ts:229–248` | — |
| R-TONE-02 | OK | `prompt.ts:254–261` | — |
| R-TONE-03 | PARTIAL | `isNameKnown` (`conversation-stage.ts:98–104`) rejects phone-like names; `extractNameAnswer` (L264–285) caps at 4 words and title-cases. But the WhatsApp profile name is ingested unchecked (`webhook-whatsapp.ts:342–348`), and nothing limits how often the model uses the name | Name frequency is unmanaged; profile names are trusted |

### 3.7 Reference scenarios `S-01`…`S-15`

Judged by code reading and the snapshot. None were executed: running them needs the real Gemini API, which this audit is forbidden to call. The Phase-2 tester owns execution.

| ID | Status | Evidence / expected failure point |
|---|---|---|
| `S-01` | **VIOLATED** | Fails twice: no explanation before the offer (R-FLOW-03), and two competing button sets at the slot step (R-SCH-01) |
| `S-02` | **VIOLATED** | `"olá, como funciona o consórcio para carro?"` → retrieval returns imóvel + serviços items and never the vehicle item (measured); and once the objective is extracted, the next turn offers the consultant (R-FLOW-03) |
| `S-03` | OK (likely) | `hasCurrentSchedulingIntent` matches "falar com um consultor" (`execute-next-action.ts:64`); `nextQuestion` L140–142 asks `consultantReason` first |
| `S-04` | PARTIAL | `"quanto fica a parcela"` → level 3 handoff with no numbers: correct. But measured: `composeStageReply` deletes the offer sentence from the handoff, so the client gets no next step (R-INF-02, R-FLOW-11) |
| `S-05` | **VIOLATED** | Measured: `"tenho 2 carros e quero uma carta"` → level 3; the stated value triggers a handoff instead of being recorded (R-INF-04) |
| `S-06` | OK (likely) | `isClearAffirmative` rejects "não, agora não" via `NEGATION_OR_DEFERRAL_PATTERN` (`pending-offer.ts:46–47`) |
| `S-07` | **VIOLATED** | A slot tapped while the session is at `awaiting_consultant_preference` hits `autonomous-task-handlers.ts:912` → `no_active_session_or_invalid_stage`, nothing sent (R-SCH-03). This is exactly the N7 Fábio case |
| `S-08` | **VIOLATED** | Expired session → `resolveChoice` returns `{ok:false, reason:"expired"}` (`scheduling-choice-service.ts:102–108`); `handleSendConfirmationRequest` L~925 returns `skipped` and enqueues nothing. No warning, no re-offer (R-SCH-03). N5: 16 stale sessions waiting to do this |
| `S-09` | **VIOLATED** | `question: null`, no state in the prompt, no buttons resent; measured accidental level-2 escalation (R-SCH-05). N7 Fábio confirms a generic reply |
| `S-10` | **VIOLATED** | Appointment date/time/consultant never reach the prompt; `prompt.ts:204–212` + `STAGE_GUIDANCE.confirmation` tell her to wind the conversation down (R-SES-05) |
| `S-11` | **VIOLATED** | N4 is this scenario, failing in production: `scheduled` is terminal, the appointment query is date-blind, stage pinned to `confirmation` (R-SES-04) |
| `S-12` | PARTIAL | Coalescing works (R-REL-01), but the window is 15 s, not 5 s, so the single reply arrives ~20 s later (§1.1) |
| `S-13` | OK | `isAlreadySaidComplaint` (`conversation-stage.ts:357–364`) + the apology injection at `composeStageReply` L400–405 |
| `S-14` | OK (likely) | `prompt.ts:273–293`; no echo path exists. Needs a live run to confirm |
| `S-15` | OK | `isAtLeast18` (`lead-qualification.ts:13–36`), `isLeadQualified` L55–61, `updateLeadFromAgent` throws |

### 3.8 Tally

| Status | Rules (§3.1–3.6) | Scenarios (§3.7) | Total |
|---|---|---|---|
| OK | 19 | 4 | **23** |
| VIOLATED | 13 | 9 | **22** |
| PARTIAL | 5 | 2 | **7** |
| UNKNOWN | 1 | 0 | **1** |
| **Total** | **38** | **15** | **53** |

---

## 4. Findings

Severity: **P0** = the client gets a wrong answer or no answer, or data is corrupted · **P1** = bad experience · **P2** = robustness · **P3** = cleanup.
Effort: S ≤ half a day · M ≤ 2 days · L > 2 days.

| ID | Area | Rules | Sev | Evidence | Root cause | Recommended fix | Effort | Risk |
|---|---|---|---|---|---|---|---|---|
| **F-01** | Process | all | P1 | `MARIANA_BEHAVIOR_SPEC.md` is in the repo **root** and **untracked**; the brief looked for `docs/specs/MARIANA_BEHAVIOR_SPEC.md`. `git grep`/`git ls-files` cannot see it | The yardstick is not versioned and not where the team looks | Owner moves it to `docs/specs/MARIANA_BEHAVIOR_SPEC.md` and commits it. Agents must cite the committed path and version | S | None |
| **F-02** | Scheduling | R-SCH-01, R-SCH-03 | **P0** | `generateMarianaResponse.ts:660–678` sends slot buttons **and then** enqueues the preference question; `autonomous-task-handlers.ts:200–208` + `L465–494`. A slot tap then hits `L912` → `no_active_session_or_invalid_stage`, nothing sent. N7 Fábio | Flow order inverted: slots are offered before the preference step the spec puts first, creating two live button sets and a stage the slot handler rejects | Make the offer turn send **only** the preference question; build and send slots **after** the preference is known. Delete `enqueueConsultantPreferenceQuestion` from the offer turn | M | Touches the main booking path; needs the full button-flow test set |
| **F-03** | Scheduling | R-SCH-03, R-FLOW-11 | **P0** | ~10 exits that `return {skipped}` with no outbound: `autonomous-task-handlers.ts:569, 776, 912`, the `button_from_another_session` / `consultant_not_active` / `consultant_no_slots` / `choiceResult.reason` / `session_changed_before_confirmation` branches, and `handleProcessButtonReply` L~297/L~345/L~370 (message only when `ok`) | Handlers equate "cannot act" with "say nothing" | One shared `respondToUnusableButtonTap(reason)` that always enqueues something: expired → notice + fresh offer; wrong stage → resend the current stage's buttons; valid slot of the active session tapped out of order → **accept it and move to confirmation**, as R-SCH-03 requires | M | Must stay idempotent; reuse the existing run keys |
| **F-04** | Sessions | R-SES-04, R-SES-05 | **P0** | N4. `generateMarianaResponse.ts:481–492` filters by status only, **never by date**; `lead-status.ts:17` `scheduled: ["scheduled"]` is terminal; `conversation-stage.ts:210–217` pins the stage. Measured | A date-blind appointment query plus a lead status with no exit edge | (a) add `gt(appointments.startAt, now)` to the query; (b) add the `scheduled → qualifying` edge; (c) gate `stage: "confirmation"` on a **future** confirmed appointment; (d) put the appointment date/time/consultant in the prompt | M | Status-machine change: re-pin `lead-status` and the `S-10`/`S-11` tests |
| **F-05** | Sessions | R-SES-02, R-SES-01 | **P0** | N2 (329 stale active conversations). No closer exists: `background-workers.ts:28–91` | The 24 h inactivity closer was never built | New `conversation-inactivity-worker`: close `active` conversations with `lastCustomerMessageAt` older than 24 h. The next inbound then opens a fresh conversation, which fixes `isFirstContact`, `getAskedQuestions` and the pendingOffer window at the same time | M | Must not close a conversation mid-booking; exclude leads with an active scheduling session |
| **F-06** | LLM config | R-FLOW-03, R-FLOW-05, R-FLOW-11 | **P0** | `agent.ts:36` lite tier; `agent.ts:240–248` no `thinkingConfig`, no `temperature`, no `maxOutputTokens`; `grep` finds no thinking setting in `src/` | The model is configured for one-shot cheap completion while being asked to satisfy ~40 rules per turn | Move the model id to env; set `temperature ≈ 0.3`, `maxOutputTokens ≈ 400`, and an explicit thinking budget; then A/B option B vs option C (§2.1.3). Validate the model id at startup | S | Cost rises (§2.1.3). Needs the turn trace (F-15) to measure |
| **F-07** | Scheduling | R-SCH-02 | **P0** | `availability.ts:75–89`: `getDay()`, `setHours(8,…)`, `setHours(18,…)` in **server local time**, against `America/Sao_Paulo` everywhere else (`google-calendar-service.ts:88,142,146`) | No timezone in the business-hours computation | Compute business hours in `America/Sao_Paulo` explicitly. Pin a test that fails with `TZ=UTC` and passes in BRT | S | Changes which slots are offered; coordinate with the owner |
| **F-08** | Guardrails | R-FLOW-12, R-REL-05 | **P0** | `validate-response.ts:76–80` and `mariana-safety.ts:117–130` **throw**. `mariana-safety.ts:12` fires on `(carta\|grupo\|lance\|estrategia) … (ideal\|melhor\|certo\|adequado)` | A guardrail hit is a crash, not a correction | Never throw on reply content. Drop the offending **sentence** (R-FLOW-12 says exactly this), log the hit, and when nothing survives use a real next step, not boilerplate. Treat an invented `evidenceUsed` id as "no evidence", not as an exception | S | Must keep the safety assertion equally strict — change only the consequence |
| **F-09** | Flow | R-FLOW-03 | **P0** | Measured: objective known → `questionKey: "consultantOffer"` immediately (`conversation-stage.ts:155`). Contradiction C1 (`prompt.ts:317`). N7 Fábio. Reinforced by `src/tests/simulation-checks.test.ts:34–48` | "Has she informed yet?" is not represented in any state, so it cannot gate the offer | Add a persisted `informedAt` / `informativeTurns` counter on the conversation (needs an approved migration — blocked by the freeze) or derive it from history in the interim. `nextQuestion` must require ≥1 informative turn **and** that the current message is not an open question before returning `consultantOffer`. Fix `prompt.ts:317` to match. Fix the simulation test, which currently blesses the violation | M | **BLOCKED on the migration freeze** for the persisted version |
| **F-10** | Scheduling | R-SCH-05 | **P0** | `conversation-stage.ts:219–220` (`question: null`), `agent.ts:96–97`, §2.2.3: no `workflowStage`, no slots, no `selectedSlotId`, no expiry in the prompt. Measured: `"está confirmada?"` → accidental level 2. N7 Fábio | The model is asked about a state it is never given | Deterministic answer: a `describeSchedulingState(session)` function producing "falta escolher o horário" / "falta confirmar", appended to the reply **and** the stage buttons resent. Also pass the state into the prompt | M | Depends on F-02 for a single coherent flow |
| **F-11** | Knowledge | R-FLOW-03, R-FLOW-11 | **P0** | Measured: `"como funciona?"`, `"me explica como funciona"`, `"quero comprar um apartamento, como funciona"`, `"é melhor que financiamento?"` all return **0 items**, after which `retrieve.ts:118–120` orders a handoff. `"carro"` never matches the vehicle item | Bag-of-words with no stemming/synonyms over a ~20-item corpus | (a) add a synonym/alias map (`carro→veiculo`, `apartamento→imovel`, …) and light stemming; (b) add a per-stage default explanation for `info` so a bare "como funciona?" always has evidence; (c) add corpus items for comparison-with-financing and for the meeting itself; (d) add `esta`, `como`, `funciona` to the stop list and require `relevance ≥ 2` or a keyword hit | M | Corpus change needs owner approval of the wording (R-INF-01) |
| **F-12** | Pipeline | R-SCH-03, R-SCH-05, R-FLOW-05 | **P0** | `webhook-whatsapp.ts:375–413`: button replies are **never** inserted into `messages` | A tap is not part of the conversation record | Persist every button tap as a `messages` row (role `user`, with the button title as content and the id in metadata). The model, the history and `getAskedQuestions` then all see it | S | Changes history content; re-pin the history and stage tests |
| **F-13** | Policy | R-INF-02, R-INF-04, R-FLOW-11 | **P0** | Measured level-3 false positives: `"quanto tempo dura a reuniao?"`, `"o que voce recomenda?"`, `"tenho 2 carros e quero uma carta"`, `"qual a disponibilidade de horarios?"`. `commercial-policy.ts:16–31, 95–105, 119–153` | The level-3 keyword list catches scheduling, duration and client-stated facts | Narrow the list: require a price/rate/bid **question** shape, not a bare keyword; carve out meeting/duration/availability; implement R-INF-04 by excluding client-stated values. Keep level 3 strictly for value/rate/bid/simulation/contemplation-forecast | M | Loosening a safety gate: every change needs a red test first |
| **F-14** | Rewriting | R-FLOW-12, R-FLOW-06 | P1 | Measured (§2.3.1): a question-only reply becomes `"Fico à disposição…"`; the 3rd fact is dropped to fit the offer; `generateMarianaResponse.ts:654` overwrites the reply **and the `messages` row** on offer turns | Enforcement by deletion. `docs/objective-flow-plan.md` §2.9 states the intent explicitly | Stop deleting questions wholesale: delete a question only when the backend is appending its own (R-FLOW-06), keep it otherwise. Raise the cap to the spec's 3 sentences. On an offer turn, **prepend** the model's explanation to the slot list instead of replacing it | M | Risks the model asking a second question; guard with a red test |
| **F-15** | Observability | R-REL-05 | P1 | No `console`/logger call in `src/ai/` or `generateMarianaResponse.ts`; `rawText` dropped at `agent.ts:250`; `metadata` returned and never persisted | Never built | Implement the turn trace of §2.3.3 | S | None. **Do this first** — every other fix is unmeasurable without it |
| **F-16** | Sessions | R-SES-01 | **P0** | N3. `webhook-whatsapp.ts:352–368` read-then-insert, no transaction; no partial unique index in `src/db/schema/conversations.ts` | No DB-level guarantee of the invariant | Partial unique index on `(leadId) WHERE status = 'active'` plus `onConflictDoNothing` and a re-read. **Needs an approved migration — blocked by the freeze.** Interim: wrap the read+insert in one transaction with `SELECT … FOR UPDATE` on the lead | S (interim) / M (index) | **BLOCKED on the migration freeze** for the index |
| **F-17** | Scheduling | R-FLOW-10 | P1 | `generateMarianaResponse.ts:680–686` and `scheduling-offer-service.ts:139–149` overwrite the assistant `messages` row with the slot text; `detectPendingOffer` and `getAskedQuestions` read exactly that text | The pending-offer marker and the asked-question set live in mutable message text | Stop overwriting the message; insert the slot offer as a **new** message. (The durable fix is a real marker column, which `CLAUDE.md` already notes is blocked by the freeze) | S | Adds one message per offer turn; check the outbox dedup keys |
| **F-18** | Scheduling | R-SCH-03 | P1 | N5: 16 sessions `active` past `expiresAt`. `expireSchedulingSessionIfOverdue` is only called lazily from `scheduling-choice-service.ts:103, 206` | No sweeper | Add session expiry to the worker set: expire overdue `active` sessions and, where the client was mid-flow, send the expiry notice + a fresh offer (ties into F-03) | S | Must not expire a session that is being confirmed concurrently |
| **F-19** | Consistency | R-SCH-03 | P1 | `autonomous-task-handlers.ts:~562, ~769, ~905` select sessions with `eq(status,'active')` and **no** `expiresAt` test, while `generateMarianaResponse.ts:382–393` adds `gt(expiresAt, now)` | Two definitions of "active session" | One `getActiveSchedulingSession(leadId, conversationId)` helper used everywhere, expiry included | S | Behaviour change where stale sessions currently still work |
| **F-20** | Reliability | R-REL-05 | P1 | N6: 36 webhook events "processing lease expired", 40 failed overall | `recoverStaleProcessingWebhookEvents` (`webhook-whatsapp.ts:33–49`) marks an expired lease **`failed`**, terminally, with no retry and no client notice | Retry a lease-expired event (bounded) instead of failing it; alert above a threshold; make a terminal failure send the client a short "não consegui responder agora" message | M | Retries must stay idempotent — the dedup machinery already supports it |
| **F-21** | LLM / cost | — | P2 | §2.2.1: ~5 580 tokens of system instruction per turn, ~90 % rules; full unwindowed history at `agent.ts:162–173` | The prompt grew by accretion; 11 contradictions (§2.2.2) | Split the prompt: a short invariant core, plus stage-specific guidance injected per turn. Resolve C1–C11. Window or summarise history | M | Prompt changes move behaviour; needs F-15 to measure |
| **F-22** | Latency | R-REL-01, `S-12` | P2 | `env.ts:34` `MESSAGE_DEBOUNCE_MS` default 15 000 ms; poll intervals 2 000 ms each (§1.1) | Debounce tuned for safety, not for feel | Lower the default to ~5 000 ms (the spec's own `S-12` figure) and keep the batching. Consider a typing indicator | S | More Gemini calls; weigh against F-06 cost |
| **F-23** | Compliance | R-REL-05 | P2 | N6: 7 outbound blocked `missing_proactive_consent`; `whatsapp-compliance.ts:46–48` | Correct per Meta policy, but there is no approved-template path, so the reply is lost | Add an approved-template path for the window-closed case, or drop the reply deliberately with a logged decision instead of a task failure | M | Meta template approval is an external dependency |
| **F-24** | Schema | — | P3 | `mariana-response-schema.ts:39` open `extractedData`; L50 required `status`; L55–57 union+default `nextAction`; L38 free-form `evidenceUsed` | Legacy v1 fields the backend discards | Drop `extractedData`, make `leadUpdate.status` optional or remove it, flatten `nextAction` to one enum, constrain `evidenceUsed` to the retrieved ids | S | Changes the contract; re-pin `mariana-response-schema.test.ts` |
| **F-25** | Tasks | R-REL-05 | P3 | N6: 2 `probe` tasks "Unsupported autonomous task type". `createAutonomousTaskHandlers` (`autonomous-task-handlers.ts:1002–1015`) has no `probe` | A task type is enqueued somewhere with no handler | Either register a no-op `probe` handler or stop enqueueing it; make an unknown type a loud permanent failure, not a silent retry loop | S | None |
| **F-26** | Tests | R-FLOW-03 | P2 | `src/tests/simulation-checks.test.ts:34–48` **passes** a transcript that offers the consultant on turn 2, right after the objective becomes known, with `offerWithinTurns: 3` | The test suite rewards reaching the offer fast, which is the inverse of R-FLOW-03 | Add a check that an informative turn precedes the first offer, and turn the "offer within N turns" check into a ceiling, not a goal. **Coordinate with the Phase-2 tester, who owns test changes** | S | Will go red until F-09 lands — that is the point |
| **F-27** | Flow | R-FLOW-02 | P1 | N7: 13 greetings. Measured: `GREETING_SENTENCE_PATTERN` (`conversation-stage.ts:366–367`) leaks greetings > 40 chars and any not starting with its 6 tokens | A brittle regex compensating for an unconstrained model | Fix at the source: `temperature ≈ 0.3` (F-06) plus a hard "não cumprimente" line when `isFirstContact` is false (already at `agent.ts:109` — it is simply not obeyed at default temperature). Keep the filter as a net but widen it and drop the 40-char limit | S | Minor |
| **F-28** | Identity | R-INF-01 | P2 | `retrieve.ts:77–85` filters out every `companyName` item when no company is configured; `prompt.ts:19` denies any administrator affiliation; `ademicon.ts` is a full Ademicon corpus; `mariana-safety.ts:51–72` scrubs the name | The corpus assumes Ademicon; the default identity denies it (C11) | Owner decision: is this an Ademicon operation or a white-label one? Then make the corpus and the identity rules agree | S | **Needs an owner decision** |

**Totals: 11 × P0 · 9 × P1 · 6 × P2 · 2 × P3 = 28 findings.**

---

## 5. Data issues (N1–N5, N8)

**Nothing in this section was executed.** Every item below is a *proposal*. Hard preconditions for any of them:

- **the owner's explicit approval**, per the ABSOLUTE RULE in `CLAUDE.md`;
- **a Neon branch or backup taken first**, since every statement here is destructive or state-changing;
- **the migration freeze in `CLAUDE.md` blocks all schema changes** until the approved baseline exists (`docs/audit-followup-report.md`). So F-16's partial unique index and F-09's persisted `informedAt` column **cannot be built yet**. The code fixes below are deliberately schema-free.

Row counts are **estimates** derived from the snapshot, not from a query run by this audit.

### N1 — ~330 of 340 leads are test fixtures

- **(a) CODE FIX.** This was caused by the test suite running against Neon. It is already fixed and must stay fixed: `src/tests/support/test-database-guard.ts` rejects a `TEST_DATABASE_URL` that is unset, equal to `DATABASE_URL`, or on `neon.tech`; `unit-test-preload.ts` points `DATABASE_URL` at `127.0.0.1:1`. Harden further by adding a fixture-name prefix convention (e.g. every seeded lead name starts with `__test__`) so future pollution is identifiable in one predicate.
- **(b) DATA FIX — proposal, do not run.** Estimated ~330 leads plus their conversations, messages, tasks, outbound rows and webhook events.

```sql
-- PROPOSAL ONLY. Needs owner approval + a Neon branch/backup first.
-- Step 1: review the candidate set before deleting anything.
SELECT id, name, phone, "createdAt"
  FROM leads
 WHERE name IN ('Cliente Teste WhatsApp','Lead Identidade Comercial',
                'Cliente Recuperado','Cliente Stale','Lead Teste Etapa 9',
                'Single Debug','X','Tmp')
    OR name LIKE 'Lead Choice/Confirmation%'
 ORDER BY "createdAt";
-- Expected ≈ 330 rows. Verify that "Davi Curty" and "Fábio Matieli" are ABSENT.

-- Step 2 (only after the owner signs off on the exact id list from step 1):
-- delete children first, or rely on ON DELETE CASCADE after confirming the FKs.
-- DELETE FROM leads WHERE id = ANY($1::uuid[]);
```

Recommendation: prefer a Neon branch for the cleanup, verify the app against the branch, then promote — rather than deleting in place.

### N2 — 329 conversations never closed for inactivity (R-SES-02)

- **(a) CODE FIX = F-05.** A `conversation-inactivity-worker` in `src/services/reliability/background-workers.ts` closing `active` conversations whose `lastCustomerMessageAt` is older than 24 h, skipping any lead with an active scheduling session. Schema-free. Must land **before** the data fix, otherwise the backlog rebuilds immediately.
- **(b) DATA FIX — proposal, do not run.** Estimated **329 rows**.

```sql
-- PROPOSAL ONLY. Run AFTER the code fix is deployed. Owner approval + backup first.
SELECT count(*) FROM conversations
 WHERE status = 'active' AND "updatedAt" < now() - interval '24 hours';   -- expect ≈ 329

-- UPDATE conversations
--    SET status = 'closed', "updatedAt" = now()
--  WHERE status = 'active' AND "updatedAt" < now() - interval '24 hours'
--    AND id NOT IN (SELECT "conversationId" FROM scheduling_sessions
--                    WHERE status = 'active' AND "expiresAt" > now());
```

### N3 — a lead with 2+ active conversations (R-SES-01)

- **(a) CODE FIX = F-16 interim.** Wrap the read-then-insert at `webhook-whatsapp.ts:352–368` in one transaction with `SELECT … FOR UPDATE` on the lead row. The durable fix is the partial unique index, which is **blocked by the freeze**.
- **(b) DATA FIX — proposal, do not run.** Estimated **1 lead, 1 surplus conversation**.

```sql
-- PROPOSAL ONLY. Owner approval + backup first.
SELECT "leadId", count(*) AS active_count, array_agg(id ORDER BY "updatedAt" DESC)
  FROM conversations WHERE status = 'active'
 GROUP BY "leadId" HAVING count(*) > 1;                                   -- expect 1 row

-- Keep the most recently updated, close the rest. Review the id list first.
-- UPDATE conversations SET status = 'closed', "updatedAt" = now() WHERE id = ANY($1::uuid[]);
```

Note: the N2 fix will close most of these as a side effect. Do N2 first, then re-check N3.

### N4 — lead `scheduled` with only a past appointment (R-SES-04)

- **(a) CODE FIX = F-04.** Date-aware appointment query, a `scheduled → qualifying` transition edge, a stage gate on a **future** confirmed appointment, and the appointment details in the prompt. Schema-free. Optionally add a recalculation worker that demotes any `scheduled` lead with no future confirmed appointment — that worker also *is* the data fix, applied continuously.
- **(b) DATA FIX — proposal, do not run.** Estimated **1 lead** ("Davi Curty"); possibly a few more once the test rows are gone.

```sql
-- PROPOSAL ONLY. Run AFTER the code fix (the status machine must accept the transition).
SELECT l.id, l.name, l.status, max(a."startAt") AS last_appointment
  FROM leads l JOIN appointments a ON a."leadId" = l.id
 WHERE l.status = 'scheduled' AND a.status IN ('confirmed','scheduled')
 GROUP BY l.id, l.name, l.status
HAVING max(a."startAt") < now();                                          -- expect ≈ 1 row

-- UPDATE leads SET status = 'qualifying', "updatedAt" = now() WHERE id = ANY($1::uuid[]);
```

### N5 — 16 scheduling sessions `active` past `expiresAt` (R-SCH-03)

- **(a) CODE FIX = F-18 + F-19.** An expiry sweep in the worker set, plus one shared `getActiveSchedulingSession` helper so every handler applies the same expiry test. Schema-free.
- **(b) DATA FIX — proposal, do not run.** Estimated **16 rows** (10 `awaiting_consultant_preference`, 5 `awaiting_availability`, 1 `awaiting_confirmation`).

```sql
-- PROPOSAL ONLY. Owner approval + backup first.
SELECT "workflowStage", count(*) FROM scheduling_sessions
 WHERE status = 'active' AND "expiresAt" <= now() GROUP BY "workflowStage";  -- expect 10/5/1

-- UPDATE scheduling_sessions SET status = 'expired', "updatedAt" = now()
--  WHERE status = 'active' AND "expiresAt" <= now();
```

These sessions are weeks old; do **not** send catch-up messages for them. Expire silently.

### N8 — 4 appointments, all in the past, 3 of them test rows

- **(a) CODE FIX.** None needed for the appointments themselves. Covered by F-04 (the status recalculation stops a past appointment from meaning "scheduled") and by N1's guard (stop writing fixtures to Neon). Worth adding: a `completed` transition for appointments whose `startAt` has passed, so `AGENDA_OCCUPYING_APPOINTMENT_STATUSES` stops counting old meetings — `appointment-status.ts:30, 39` already allow `confirmed → completed` and `scheduled → completed`.
- **(b) DATA FIX — proposal, do not run.** Estimated **3 rows** ("Ana Teste", "Davi Teste", status `scheduled`, Oct 2–3), removed with their leads in N1(b). Davi's real Oct 16 appointment should be **kept** and may be moved to `completed`.

```sql
-- PROPOSAL ONLY.
SELECT id, "leadId", status, "startAt" FROM appointments ORDER BY "startAt";  -- expect 4 rows
-- UPDATE appointments SET status = 'completed', "updatedAt" = now()
--  WHERE status IN ('confirmed','scheduled') AND "startAt" < now();
```

---

## 6. Target design

Both alternatives are judged against the `CLAUDE.md` invariants, which are non-negotiable: one active conversation per lead; no duplicate inbound processing; an outbound that may have reached Meta never returns to `pending`; `unknown` is never resent without evidence; **the AI is never the authority on IDs, availability or authorization**; confirming a slot requires equality with the persisted `selectedSlotId`.

### Alternative A — keep the deterministic state machine, give the LLM the full state, stop mutilating its replies

**Shape.** The backend keeps owning the stage, the status, the slot ids and the authorisation, exactly as today. Three things change:

1. **The prompt receives the complete state**: scheduling `workflowStage`, the offered slots, `selectedSlotId`, session expiry, the appointment date/time/consultant, whether an informative turn has already happened, and the button taps (now persisted as messages — F-12).
2. **The output layers stop deleting.** Delete a model question only when the backend is appending its own; respect the spec's 3-sentence cap; never throw on reply content — drop the offending sentence (R-FLOW-12); on an offer turn **prepend** the model's explanation to the slot list instead of replacing it.
3. **The state model gains the two facts it lacks**: "has she informed?" (gates the offer, R-FLOW-03) and "is the appointment in the future?" (gates `confirmation`, R-SES-04).

**Invariants.** Fully preserved, by construction. Slot ids never originate with the model; `scheduling-choice-service.ts:117–144` keeps the `selectedSlotId` equality in the UPDATE predicate; authorisation stays in `executeNextAction`. The AI gains *visibility*, not *authority* — exactly the distinction `CLAUDE.md` draws.

**Pros.** Every fix is incremental and independently testable. No new failure mode. The P0 list is a sequence of small plans. The existing invariant tests keep their meaning. Cheap to roll back per change.

**Cons.** The stage machine stays rigid: a client who does three things in one message still gets one scripted question. "Has she informed?" is a patch on a model that was never designed to represent conversational progress. The prompt stays large and will keep accreting contradictions.

### Alternative B — LLM-led with tool calls, backend validation of every side effect

**Shape.** The model drives the turn and calls tools: `get_conversation_state()`, `get_knowledge(topic)`, `record_lead_fact(field, value)`, `offer_consultant()`, `get_available_slots()`, `select_slot(slot_id)`, `confirm_slot(slot_id)`, `handoff_to_consultant(reason)`. Every tool is a thin wrapper over today's deterministic services and **re-validates server-side**: `confirm_slot` still requires equality with the persisted `selectedSlotId`; `get_available_slots` still comes from Google Calendar; `record_lead_fact` cannot write `status` or `interestedInConsultant`; `offer_consultant` still returns the fixed `CONSULTANT_OFFER_TEXT`.

**Invariants.** Preservable, but only if every tool is written as a guard rather than a setter. The risk is not theoretical: the AI becomes the *proposer* of slot ids, so a bug in one tool wrapper turns into a wrong booking, where today the regex gate makes that structurally impossible. It also requires a capable tier with real thinking (option C/D in §2.1.3) and multi-turn tool loops — 3–5× the cost and latency of today.

**Pros.** The conversation stops being scripted. Out-of-order input, multi-fact messages and "está confirmada?" become natural. The 11 prompt contradictions largely dissolve, because the model asks for state instead of being lectured about it. R-FLOW-03 becomes a one-line tool precondition instead of a new persisted field.

**Cons.** A rewrite of the turn pipeline (`generateMarianaResponse`, `execute-next-action`, all six handlers). Far harder to test: the current suite asserts on deterministic strings. Non-determinism in the booking path is the highest-risk place to put it. Latency and cost both rise. And it would be built on a base where the owner cannot yet measure quality at all (F-15).

### Recommendation: **A now, with the pipeline shaped so B stays reachable.**

Reasons, in order:

1. **The symptoms are not caused by the architecture.** Every one of the five reported symptoms traces to a concrete defect that A fixes: #1 "offers before explaining" = C1 + `conversation-stage.ts:155` + empty retrieval for "como funciona?"; #2 "repeats questions and greetings" = the 40-char greeting regex + fixed handoff texts outside the asked-question tracking; #3 "ignores button taps" = F-02 + F-03 + F-12; #4 "doesn't know the scheduling state" = the state is computed and then not passed (§2.2.3); #5 "carries old state" = no inactivity closer (F-05). **None of these is evidence that a state machine is the wrong architecture.** They are evidence that the state machine is fed badly and that its output is mutilated.
2. **B would inherit all of them.** An LLM-led agent on top of a knowledge base that returns nothing for "como funciona?", a timezone-broken availability calculator and a lead status that can never leave `scheduled` reasons just as badly, more expensively, and less predictably.
3. **The invariants are the point of the product.** A's guarantees are structural; B's are conventional (every tool must be written correctly). With a lite model today and no turn tracing, B's risk is unmeasurable.
4. **Nothing is measurable yet.** F-15 is the precondition for any architectural claim, including this one.

**Migration path from today's code**, ordered so that B stays available:

1. **Turn tracing (F-15).** Now you can see what the model wrote vs what was sent.
2. **Model config (F-06).** Env-driven model id, `temperature ≈ 0.3`, explicit thinking budget, `maxOutputTokens`. Measure against the trace. This alone tests the "she doesn't reason" hypothesis for the price of a config change.
3. **State into the prompt, and `src/services/conversations/conversation-state.ts` as its single source.** One function returning the whole turn state (lead + stage + scheduling session + appointment + informed flag). A consumes it as prompt text; **B would consume the same function as `get_conversation_state()`**. Building this now is what keeps B one step away instead of one rewrite away.
4. **Stop mutilating (F-14, F-08).**
5. **Fix the flow defects** (F-02, F-03, F-04, F-05, F-07, F-09, F-12, F-13).
6. **Then, and only then, reconsider B** — with real traces and a real quality baseline, for the `info` and objection stages first, keeping the booking path deterministic. A hybrid where the LLM leads the conversational stages and the state machine owns the booking is the likely end state, and step 3 is what makes it cheap.

---

## 7. Prioritized roadmap

Each package is small enough to become one plan. "Fixes" lists rule IDs.

| # | Package | Findings | Fixes | Depends on | Notes |
|---|---|---|---|---|---|
| **WP-0** | **Turn tracing and model config** | F-15, F-06 | R-REL-05; makes R-FLOW-03/05/11 measurable | — | Do this first. Config + logging only, no behaviour change beyond the model settings. Validate the model id at startup (prevents N6 repeating) |
| **WP-1** | **Never leave a tap unanswered** | F-03, F-12, F-19 | R-SCH-03, R-FLOW-11 | WP-0 | One `respondToUnusableButtonTap`; persist taps as messages; one shared active-session helper. Highest client-visible win |
| **WP-2** | **One scheduling path** | F-02, F-17 | R-SCH-01, R-SCH-03, R-FLOW-10 | WP-1 | Preference first, then slots. Removes the two competing button sets and the cause of the N7 Fábio drop |
| **WP-3** | **Scheduling state is answerable** | F-10 | R-SCH-05, `S-09` | WP-2 | `describeSchedulingState` + resend the stage buttons + state in the prompt |
| **WP-4** | **Conversation lifecycle** | F-05, F-16 (interim), F-18 | R-SES-01, R-SES-02, R-SCH-03 | WP-0 | Inactivity closer + session expiry sweep + transactional conversation creation. Schema-free. Unblocks the N2/N3/N5 data fixes |
| **WP-5** | **Appointment truth** | F-04 | R-SES-04, R-SES-05, `S-10`, `S-11` | WP-4 | Date-aware query, `scheduled → qualifying` edge, appointment details in the prompt |
| **WP-6** | **Real business hours** | F-07 | R-SCH-02 | — | Independent. Small and self-contained; pin a `TZ=UTC` red test |
| **WP-7** | **Stop mutilating the reply** | F-14, F-08, F-27 | R-FLOW-02, R-FLOW-06, R-FLOW-12, R-REL-05 | WP-0 | Guardrails drop a sentence instead of throwing; keep model questions when the backend adds none; widen the greeting net |
| **WP-8** | **Inform before offering** | F-09, F-26 | R-FLOW-03, `S-01`, `S-02` | WP-7, WP-10 | **Partly BLOCKED**: the persisted `informedAt` needs an approved migration. The history-derived interim is not blocked. Coordinate F-26 with the Phase-2 tester |
| **WP-9** | **Sensitive-topic gate, narrowed** | F-13 | R-INF-02, R-INF-04, R-FLOW-11, `S-04`, `S-05` | WP-0 | Loosening a safety gate: red test per case, owner review of each carve-out |
| **WP-10** | **Knowledge that answers "como funciona?"** | F-11 | R-FLOW-03, R-FLOW-11, `S-02` | WP-0 | Synonyms + stemming + stop-list + stage defaults + new corpus items. Corpus wording needs owner approval (R-INF-01) |
| **WP-11** | **Prompt surgery** | F-21, F-24 | R-FLOW-06, consistency | WP-0, WP-7 | Resolve C1–C11, split invariant core from per-stage guidance, window the history, tighten the response schema |
| **WP-12** | **Reliability tail** | F-20, F-23, F-25, F-22 | R-REL-05, R-REL-01, `S-12` | WP-0 | Lease-expired retry, template path for the closed window, `probe` handler, debounce 15 s → 5 s |
| **WP-13** | **Data fixes on Neon** | §5 (b) | R-SES-01, R-SES-02, R-SES-04, R-SCH-03 | WP-4, WP-5 | **Owner approval + Neon branch/backup required.** Order: N1 → N2 → N3 → N5 → N4 → N8 |
| **WP-14** | **Migration baseline, then the blocked fixes** | F-16 (index), F-09 (column) | R-SES-01, R-FLOW-03 | migration freeze lifted | Blocked until the approved baseline exists (`docs/audit-followup-report.md`, `CLAUDE.md`) |
| **WP-15** | **Spec hygiene** | F-01, F-28 | process, R-INF-01 | — | Move and commit the spec at `docs/specs/MARIANA_BEHAVIOR_SPEC.md`; owner decides the Ademicon vs white-label identity |

---

## 8. Questions for the owner

1. **The spec.** `MARIANA_BEHAVIOR_SPEC.md` is untracked and in the repo root, not `docs/specs/`. Should it be moved to `docs/specs/MARIANA_BEHAVIOR_SPEC.md` and committed, so agents can cite a versioned path? (F-01)
2. **Model choice.** Option B (same lite model + explicit thinking + `temperature ≈ 0.3`) or option C (`gemini-3.5-flash` mid tier + thinking) from §2.1.3? I recommend trying B first because it is a config change, then C if the traces still show weak reasoning. Both raise cost; the estimates are in §2.1.3. And: should the model id move to an env var so a 404 can be rolled back without a deploy? (F-06)
3. **Identity.** Is this an **Ademicon** operation or a white-label one? The corpus is Ademicon's, `prompt.ts:19` denies any administrator affiliation, and `retrieve.ts:77–85` hides every Ademicon item unless a company is configured. The three cannot all be right. (F-28, C11)
4. **R-FLOW-03 definition.** What exactly counts as "pelo menos uma resposta informativa"? One assistant turn that used authorised evidence? One turn in the `info` stage? I need a testable predicate before WP-8 can be planned. (F-09)
5. **R-INF-02 carve-outs.** May Mariana answer, from authorised knowledge and without a handoff: the meeting duration (30 min, already in `prompt.ts:182`), the meeting format (Google Meet), and a generic "consórcio vs financiamento" comparison? All three are currently trapped at level 3. (F-13, F-11)
6. **Latency vs batching.** Drop `MESSAGE_DEBOUNCE_MS` from 15 s to 5 s, matching the spec's own `S-12`? It roughly doubles the Gemini call count but cuts perceived latency by two thirds. (F-22)
7. **Data fixes.** Do you approve §5's proposals in principle, to be executed later, one at a time, each on a Neon branch with a backup first and the exact id list reviewed by you? **Nothing has been run.** (WP-13)
8. **Migration freeze.** F-16 (partial unique index on one active conversation per lead) and F-09 (a persisted `informedAt`) both need schema changes. Do we wait for the approved baseline, or do you want to prioritise the baseline so these two can land? (WP-14)
9. **Scheduling order.** R-SCH-01 puts the consultant preference before the times. Today the code sends the times first and the preference second. Confirm that preference-then-times is the intended order and I will plan WP-2 accordingly. (F-02)
10. **R-SES-05 vs the prompt.** The spec says keep helping a client with a future appointment; `prompt.ts:204–212` tells Mariana to end the conversation after booking. The spec wins per its own rule, but confirm, since it changes post-booking behaviour. (C10)

---

## 9. Method, and what was not done

- **Read-only.** No product code, test, migration, config or `.env` file was touched. No `git` write command of any kind was run.
- **No network, no API calls.** No Gemini, no WhatsApp, no Google Calendar, no Neon. `npm run sim:conversation` was **not** run. All model-tier figures are documentation knowledge and are labelled as estimates.
- **Measurements** came from three read-only `tsx` scripts importing **only** `src/ai/knowledge/*`, `src/ai/prompt.ts`, `src/ai/agent.ts` (for `buildConversationContextSection`) and `src/services/conversations/conversation-stage.ts`, run with `env -u DATABASE_URL` so no connection was possible. They live outside the repo, in `/tmp/claude-1000/-home-davi-curty-Documentos-Programing-Projects-mariana/16b382f4-8a68-4b31-b015-0bba89a57313/scratchpad/` (`probe-retrieval.ts`, `probe-compose.ts`, `probe-greet.ts`, `probe-size.ts`).
- **Test suites were not run.** The Phase-2 tester owns that. Test files were read as evidence only.
- **Not covered**, and worth a later look: `src/routes/meta-ads/webhook-meta-ads.ts` and `src/routes/google-ads/webhook-google-ads.ts` (lead ingestion from ads), the Google OAuth route (`src/routes/google-calendar/auth-google.ts`, and N6's single "Nenhuma conexão Google Calendar encontrada" failure), and runtime verification of R-SCH-06 (double-booking), which needs a DB.
