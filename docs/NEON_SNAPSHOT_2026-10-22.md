# Neon snapshot — 2026-10-22 (read-only analysis)

Project `floral-salad-13360739` (Mariana). All queries were SELECT-only. Rule IDs refer to `MARIANA_BEHAVIOR_SPEC.md`.

## Volume
- 340 leads, 337 conversations, 816 messages, 4 appointments, 17 scheduling sessions, 248 autonomous tasks, 216 outbound messages, 550 webhook events, 3 consultants, 1 Google connection.
- Last message: 2026-10-17 23:05 UTC. Only 18 messages in the last 5 days.

## N1. The database is mostly test data
About 330 of the 340 leads are test fixtures written when the test suite ran against Neon on Oct 13–14:
- "Cliente Teste WhatsApp" (95);
- "Lead Identidade Comercial" (58);
- "Cliente Recuperado" (49);
- "Cliente Stale" (48);
- "Lead Teste Etapa 9" (17);
- "Lead Choice/Confirmation …", "Single Debug", "X", "Tmp"…

Real leads: "Davi Curty" (3cc1444c), "Fábio Matieli" (94a47916), and a few numeric-named leads from Oct 2. Any metric over the whole table is polluted.

## N2. Conversations are never closed for inactivity — R-SES-02
329 conversations are `active`, and all 329 have had no update for more than 24h.

## N3. A lead with more than one active conversation — R-SES-01
One lead has 2+ active conversations (invariant violation).

## N4. "scheduled" with only a past appointment — R-SES-04
Lead "Davi Curty" has status `scheduled`, but his only appointment (confirmed, 2026-10-16 11:00 UTC = 08:00 BRT) is in the past. This explains "a Mariana lembrou de quinta-feira" (P4).

## N5. Scheduling sessions never expire in the DB — R-SCH-03
16 sessions are still `active` long after their `expiresAt`:
- 10 in `awaiting_consultant_preference`;
- 5 in `awaiting_availability`;
- 1 in `awaiting_confirmation`.
Expiry is only checked lazily, so these rows remain and can confuse stage logic.

## N6. Failures
- `process_inbound_message` failed 19 times (Oct 13–14):
  - 14× Gemini 404 "models/gemini-3.6-flash-lite not found";
  - 4× "gemini-2.5-flash no longer available";
  - 1× "Nenhuma conexão Google Calendar encontrada".
  Each failure = a client without a reply (R-REL-05). The model name changed several times; the code now uses `gemini-3.5-flash-lite` (a lite tier — relevant to the "lack of reasoning" complaint).
- `whatsapp_webhook_events`: 40 failed (36 "processing lease expired", 3 "previous failure", 1 failed query on `scheduling_sessions`).
- `outbound_messages`:
  - 7 failed "missing_proactive_consent";
  - 3 unknown (2 network errors from the broken IPv6, 1 "sending lease expired").
- 2 tasks of type `probe` failed "Unsupported autonomous task type".

## N7. Conversation quality (real leads)
- Davi: 67 user messages, 55 bot replies, 7 conversations. **13 bot replies start with a greeting** (R-FLOW-02).
- Repeated bot texts:
  - the handoff "Essa é uma questão específica…" 5×;
  - "Você gostaria de conversar com um consultor…" 5×;
  - "Posso ajudar com suas dúvidas…" 3×;
  - the objective question 2×.
  (R-FLOW-05 / R-FLOW-11)
- Fábio (Oct 17):
  - the consultant offer came before any explanation (R-FLOW-03);
  - two competing button sets were sent (R-SCH-01);
  - a slot tap was ignored with `no_active_session_or_invalid_stage` (R-SCH-03);
  - "está confirmada?" got a generic reply (R-SCH-05).

## N8. Appointments
All 4 appointments are in the past. 3 are old test rows ("Ana Teste", "Davi Teste", status `scheduled`, Oct 2–3). The only real one is Davi's, confirmed on Oct 16.

## Pending owner decisions (not done)
- Clean the test data from Neon (destructive; needs explicit approval and preferably a Neon branch backup first).
- Close the stale active conversations and expire the stale sessions (data fix, after the code fix).
