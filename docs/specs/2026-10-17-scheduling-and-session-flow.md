# Spec — Scheduling flow and conversation sessions (2026-10-17)

Task id: `2026-10-17-scheduling-flow`
Owner: Davi. Team: planner → implementer → tester (see `docs/AGENT_TEAM.md`).
Rules: `CLAUDE.md` applies in full. **Never commit** — the owner commits.

## 1. Problems seen in production (Neon, read-only evidence)

### P1. No explanation before the consultant offer
Conversation `3430ebdc-db51-45d0-8d28-3594698a9a06`:
```
22:56 user: olá, gostaria de saber como funciona o consórcio para carro
22:57 bot : Você quer que eu procure um horário para conversar com um consultor?
```
The client asked how it works. Mariana skipped the explanation and offered a meeting.

### P2. Two scheduling flows at once, and a button tap ignored in silence
```
22:58 user: sim
22:59:18 outbound buttons: "Tenho estes horários disponíveis…" [19/10 08:00 | 08:30 | 09:00]
22:59:20 outbound buttons: "Você tem preferência por algum consultor?" [Tenho preferência | Sem preferência]
         scheduling_session c53c5f95… workflowStage = awaiting_consultant_preference
23:00 user taps slot "19/10 às 08:00"
         task send_confirmation_request -> {"skipped":true,"reason":"no_active_session_or_invalid_stage"}
         (nothing sent to the client)
```
No appointment was created. The session expired 15 minutes later.

### P3. Mariana does not know the scheduling state
```
23:05 user: está confirmada a reunião?
23:05 bot : Fico à disposição para qualquer dúvida sobre consórcio.
```

### P4. An old conversation "leaks" into a new one / the lead is stuck after scheduling
Lead `3cc1444c-…` has a confirmed test appointment from Oct 16 and status `scheduled`. On Oct 17:
- every inbound message created a NEW conversation that was closed immediately (4 closed conversations of 2 messages each);
- the bot treated the client as "already scheduled" ("Como sua reunião já está agendada, encerro por aqui"), answered "quais os processos para isso?" with "o consultor poderá detalhar… na reunião já agendada", and refused "eu quero agendar outra reunião".

From the owner's point of view, Mariana "remembered Thursday's session" and got confused.

## 2. Suspected root causes (the planner must confirm or refute each)
1. `src/services/conversations/conversation-stage.ts` → `nextQuestion` jumps to `consultantOffer` as soon as `objective` is known. There is no "inform first" step.
2. When Gemini requests a blocked scheduling action, `persistAuthorizedAssistantReply` (`generateMarianaResponse.ts`) replaces the whole reply with `fallbackReply` = `composeStageReply({ modelReply: "" })`, discarding the informative sentences.
3. `handleProcessInboundMessage` (`autonomous-task-handlers.ts` ~L200) sends slot buttons via `buildWhatsAppSchedulingOffer`. Meanwhile `generateMarianaResponse` enqueues `send_consultant_preference_question`, leaving the session in `awaiting_consultant_preference`.
4. Handlers returning `no_active_session_or_invalid_stage` (~L569, ~L776, ~L912) skip without sending anything to the client.
5. During an active session, Gemini gets no scheduling state.
6. `computeConversationStage` returns `confirmation` whenever `lead.status === "scheduled"`, regardless of whether the appointment is in the past or the future. Something closes the conversation on every message for scheduled leads, so each new message opens a new conversation. Lead-level fields (status, objective, interest) carry over from an old conversation as if they were current.
7. The existing test "oferta de agenda pergunta a preferência antes de exibir slots" passes because it only checks that the preference question was sent. It does not check that slot buttons were NOT sent.

## 3. Product decisions (approved by the owner)

### D1. Inform first
- If the client asks how consórcio works, wants to know more, or asks any general question, the reply MUST answer it from the authorized knowledge base (2–3 short sentences) before any consultant offer.
- `CONSULTANT_OFFER_TEXT` is only appended when ALL of these hold:
  - at least one informative answer was already delivered in this conversation;
  - the current message is not an open question;
  - the client has not declined.
- An explicit request ("quero falar com consultor", "quero agendar") still goes straight to the offer.
- Sensitive questions still get the handoff + offer.

### D2. Never discard useful text
When a scheduling action or promise is blocked, remove only the offending sentences (promises of times or booking). Keep the informative sentences, then append the stage question.

### D3. One scheduling path, in this order
1. consultant preference question;
2. (if "Tenho preferência") consultant buttons;
3. slot buttons;
4. confirmation buttons (Confirmar / Não);
5. final confirmation with date, time and consultant.

The inbound handler must not send slot buttons when the session starts at `awaiting_consultant_preference`. Keep the single-slot shortcut only if it does not conflict.

### D4. No silent button taps
Every button reply that cannot be applied gets a short message plus the correct buttons for the current step:
- expired session → "Esses horários expiraram, vou buscar novos" + a fresh offer;
- wrong stage → re-send the current step's buttons;
- invalid slot or slot of another session → apology + current step.

Special case: a valid, persisted slot of the ACTIVE session tapped while awaiting preference → accept it, set `selectedSlotId`, move to confirmation, and skip the preference step.

All invariants still hold: IDs are validated by the backend, and confirm must equal `selectedSlotId`.

### D5. Free text during an active scheduling session
Answered deterministically from the session state:
- "está confirmada?" / "e agora?" → say what is missing ("Ainda falta escolher o horário" / "Falta confirmar") + re-send the current buttons;
- a question about consórcio → short answer + re-send the current buttons.

Gemini receives the scheduling state in its context.

### D6. Conversation sessions — no leaking between conversations
- **One active conversation per lead** (existing invariant). Never create and close a conversation per message.
- A conversation is closed after **24 hours without client messages** (inactivity), and only then. The next message opens a fresh conversation.
- **A fresh conversation starts a fresh dialogue:**
  - stage = greeting;
  - no message history from previous conversations goes to Gemini (confirm that this is already true);
  - qualification flags from a previous conversation (`interestedInConsultant`, accepted offers, pending offers) do NOT carry over: reset `interestedInConsultant` to false at the start of a new conversation;
  - durable facts (name, phone) may be reused;
  - `objective` / `consortiumType` may be reused only as a *hint*: Mariana may confirm them in one short sentence ("Da última vez você falou de um carro novo, é isso ainda?") but must not skip the reason step silently.
- **`scheduled` only while there is a FUTURE confirmed appointment.**
  - If the lead's confirmed appointments are all in the past, the lead goes back to the normal flow (treat as `qualifying`/`new` for stage purposes; persist a status change only through the existing status-transition rules — the planner proposes how).
  - If a future confirmed appointment exists:
    - mention it once with date, time and consultant (deterministic, from the appointment);
    - otherwise answer questions normally;
    - do NOT close the conversation;
    - "quero agendar outra / remarcar / cancelar" → reply that the consultant will handle the change, and record the request (log/flag). No automatic rescheduling in this task.
- No schema migration. If D6 truly needs one, the planner marks the step BLOCKED and asks the owner.

## 4. Acceptance criteria (the tester maps every one to tests)
- AC1. A first message "como funciona o consórcio para carro" → a reply with an explanation from the knowledge base and NO consultant offer. The offer comes in a later turn.
- AC2. A blocked `offer_meeting` with an informative model reply → the informative sentences are kept.
- AC3. "sim" to the offer → exactly ONE outbound with buttons (the preference question) in that turn. No slot buttons.
- AC4. The full happy path, with preference and without preference: … → slots → Confirmar → appointment created (Calendar mocked) → final confirmation message.
- AC5. A slot tapped while awaiting preference → accepted, confirmation buttons sent.
- AC6. A tap on an expired session → message + new offer. A wrong-stage tap → message + current buttons.
- AC7. No button handler ever returns `skipped` without enqueuing a reply to the client (a test over all handlers).
- AC8. "está confirmada a reunião?" in each session stage → a correct state message + current buttons.
- AC9. A lead with a PAST confirmed appointment writes "oi" → greeting, the normal flow, no "já está agendada".
- AC10. A lead with a FUTURE confirmed appointment:
  - "quais os processos?" → answered, conversation stays active;
  - "está confirmada?" → date, time and consultant;
  - "quero agendar outra" → the handoff message;
  - no new conversation per message.
- AC11. A new conversation after 24h of inactivity starts at greeting; `interestedInConsultant` is reset; no previous-conversation history goes to Gemini; the objective is only confirmed, not silently assumed.
- AC12. Three messages in a row within 24h stay in ONE conversation (no create-and-close).
- AC13. The production transcripts of P1–P4 replayed end to end now behave as specified.
- AC14. All suites green:
  - `npm run test:unit`;
  - `npm run test:db` (local, twice);
  - `npx tsc --noEmit`;
  - `npm run build`;
  - biome on the changed files;
  - `git diff --check`.

## 5. Out of scope
- Automatic rescheduling or cancellation by Mariana.
- Admin API for consultants.
- Migration consolidation.
- Changing the confirmation message wording.

## 6. Data cleanup (owner, after the code is ready — not the agents)
Before the next WhatsApp test, the owner asks Claude (chat) to clean the test leads `3cc1444c-…` and `94a47916-…` in Neon, and deletes the Oct 16 test event from Google Calendar.
