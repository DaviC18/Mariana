# Objective Flow — Design and Plan

**Goal:** Mariana reaches scheduling in a short, predictable conversation. The backend owns the stage and the question. Gemini only writes the reply text.

**Evidence:** lead `3cc1444c-…`. Scheduling was blocked by a missing `currentSituation`. Gemini chose and repeated the questions, and an explicit request for a consultant was ignored.

## 1. Stage machine (pure, `src/services/conversations/conversation-stage.ts`)

`computeConversationStage(input) -> StagePlan` takes the following inputs:

- the persisted lead: `name`, `phone`, `objective`, `consortiumType`, `currentSituation`, `painPoint`, `interestedInConsultant`, `status`;
- the assistant messages in history;
- whether an active scheduling session exists.

The stages are listed below. The first rule that matches wins.

| Stage | Condition | Backend question |
|---|---|---|
| `confirmation` | lead `scheduled` | none |
| `scheduling` | active scheduling session, or lead `qualified` and `interestedInConsultant` | none |
| `greeting` | no assistant message yet | next question below (name or reason) |
| `name` | name unknown (empty, equals the phone, or digits only) and `NAME_QUESTION` not asked | `NAME_QUESTION` |
| `reason` | `objective` empty and no reason question asked | `REASON_QUESTION`, or `CONSULTANT_REASON_QUESTION` when the client asked for a consultant |
| `consultant_offer` | `objective` known, `interestedInConsultant` not true, `CONSULTANT_OFFER_TEXT` not asked | `CONSULTANT_OFFER_TEXT` |
| `info` | everything else | first optional field that is missing and not yet asked (`currentSituation`, then `painPoint`), else none |

"Already asked" is derived from the history with no migration. A field counts as asked when an assistant message contains one of its backend-owned texts. This includes the legacy `qualification-gaps` texts, so old conversations are covered. A question that was asked is never sent again. The only exception is the scheduling flow, which the client must start explicitly.

## 2. Turn pipeline (`generateMarianaResponse`)

1. Load the lead, the conversation and the history (unchanged).
2. **Pending marker** (`pending-offer.ts`). Read the immediately previous assistant message:
   - if it contains `CONSULTANT_OFFER_TEXT`, the marker is `consultant_meeting`;
   - if it contains `CONSULTANT_REASON_QUESTION`, the marker is `consultant_reason`;
   - otherwise there is no marker.

   The marker is valid for this turn only.
3. Compute the pre-turn `StagePlan` and send it to Gemini (§3).
4. Call Gemini. Level-3 sensitive messages still short-circuit in `agent.ts` to `COMMERCIAL_HANDOFF`, which now ends with `CONSULTANT_OFFER_TEXT`.
5. **Reconcile `leadUpdate`** with `reconcileLeadUpdate`, a pure function:
   - drop Gemini's `status` and `interestedInConsultant`, because the backend owns both;
   - infer `consortiumType` from `objective` with keywords (veículo / imóvel / serviços);
   - when `painPoint` carries situational text ("já tenho", "moro de aluguel", "não tenho"…) and `currentSituation` is empty, move it to `currentSituation`;
   - accept `name` only when the current name is unknown.
6. **Backend signals:**
   - `acceptedOffer` = marker `consultant_meeting` and `acceptsPendingOffer`;
   - `explicitRequest` = `hasCurrentSchedulingIntent`, extended with consultant and human-agent phrases and still rejecting negations;
   - `reasonAnswered` = marker `consultant_reason` and the objective is now known.

   If any of the three is true, the backend sets `interestedInConsultant = true`.
7. **Status is computed by the backend.**
   - A lead in `new` moves to `qualifying`.
   - A lead becomes `qualified` when `isLeadQualified(merged)` holds. The rule is: objective present, `interestedInConsultant === true`, and 18+ when a birthDate exists.
   - The backend never sets `scheduled`.
8. `executeNextAction({ acceptedPendingOffer: acceptedOffer || reasonAnswered, ... })`.
   - When there is a current intent (accepted offer, accepted reason, or explicit request), `continue_qualification`, `request_consultant` and `offer_meeting` all become `offer_meeting`.
   - `close` stays `close`. `schedule_meeting` is unchanged.
   - The `qualified` gate stays in place.
9. **Compose the reply** with `composeStageReply`, which is pure:
   - remove repeated greetings when this is not the first contact;
   - remove every question sentence that Gemini wrote;
   - keep at most 2 Gemini sentences, then append the post-turn backend question.

   If nothing is left, use a neutral fallback, chosen so the same fallback is never sent twice in a row. If the turn is "já disse isso", prepend "Desculpe!". When the action is `request_consultant`, the reply stays `COMMERCIAL_HANDOFF`.
10. `persistAuthorizedAssistantReply` is unchanged. A scheduling promise without authorization is still replaced with the composed fallback. Slot offers still replace the reply when `offer_meeting` executes.

## 3. Data sent to Gemini on each turn

`conversationContext` now carries:

- `stage`;
- `question`, the one question the backend will append, or none;
- `doNotAsk`: the known fields and the questions already asked;
- `isFirstContact`;
- `pendingOffer`.

The prompt tells Gemini not to write questions, because the application appends the question. `buildConversationContextSection` replaces the old "campos pendentes / nunca use offer_meeting" text.

## 4. Where `CONSULTANT_OFFER_TEXT` is appended

`CONSULTANT_OFFER_TEXT` is defined in `src/ai/knowledge/commercial-policy.ts` as "Você quer que eu procure um horário para conversar com um consultor?". It is appended in two places:

- in `composeStageReply`, when the stage is `consultant_offer`;
- inside `COMMERCIAL_HANDOFF`, as a short handoff sentence followed by the offer.

Gemini never writes it.

## 5. Interaction with existing guards

- `executeNextAction` is still the only place that authorizes `offer_meeting`, and it still requires `qualified`. Authorization lasts one turn.
- `persistAuthorizedAssistantReply`: unchanged.
- Scheduling offer and confirmation (`SchedulingOfferService`, the task handlers, the confirmation orchestrator): unchanged.
- `SchedulingAvailabilityService` still rejects leads that are not `qualified`. `/appointments/availability` follows the new minimum through `isLeadQualified` and the status.
- Compliance (`whatsapp-compliance`, opt-out, 24h window) and the outbox: untouched.

## 6. Invariants from CLAUDE.md

- **One active conversation, no duplicate inbound processing, outbound `unknown`/`pending` rules:** these code paths are untouched.
- **AI is not the authority:** the backend now owns `status`, `interestedInConsultant`, the question and the offer text. Slots still come from persisted availability.
- **Confirming a slot requires the persisted `selectedSlotId`:** confirmation services are unchanged.
- **Pending offer:** the exact-text marker is read from the immediately previous assistant message and covers one user turn. This text marker lets the path go live without a migration. Its limitation: if the offer text changes, older offers in history stop matching.
- **18+ rule:** unchanged.
- **Migration freeze:** no schema change.

## 7. Tasks (TDD: red, then green)

1. Write the red tests: a transcript replay (`src/tests/services/objective-flow.test.ts`, DB) plus unit tests for each root cause.
2. `lead-qualification.ts` / `qualification-gaps.ts`: new minimum, question constants, `isFieldAsked`.
3. `conversation-stage.ts`: `computeConversationStage`, `reconcileLeadUpdate`, `composeStageReply`, `splitSentences` (unit tests).
4. `pending-offer.ts`: `detectPendingOffer(previousAssistantMessage)`.
5. `execute-next-action.ts`: consultant intent phrases and the override.
6. `commercial-policy.ts`: `CONSULTANT_OFFER_TEXT`, the new `COMMERCIAL_HANDOFF`, more level-3 phrases ("quanto fica a parcela", "quanto de lance"…).
7. Wire everything in `generateMarianaResponse.ts` and `agent.ts` (context section, `name` in `leadUpdate`), and update `prompt.ts` with the verbatim section as priority 4. Remove the conflicting rules.
8. Phase 4 test matrix, `scripts/simulate-conversation.ts`, and `CLAUDE.md`.

Verification after each task: `npm run test:unit`, `npm run test:db` (local `localhost:5432/mariana_test`), and `npx tsc --noEmit`.
