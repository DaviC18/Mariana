# Mariana — project rules

Fastify + Drizzle/Postgres + Gemini + WhatsApp Cloud API. Follow these rules in every session.

## Safety
- `DATABASE_URL` in `.env` is the real Neon database. Never run tests, migrations, seeds, `db:push` or any write against it.
- DB work runs only against a disposable local DB (Docker `mariana-postgres`) set via `TEST_DATABASE_URL`. Before running anything, print the target host and database name, never the password.
- `RELIABILITY_WORKERS_ENABLED=false` in every test run. If `npm run dev` may be running against the same DB, stop and ask.
- Never send real WhatsApp messages or call real Gemini/Google APIs. Mock them.
- No `git push`, no force operations. Commit locally on a feature branch only.

## Tests
- Unit (no DB): `npm run test:unit`. It points `DATABASE_URL` at an unreachable address, so a test that touches the DB fails instead of reaching Neon.
- DB tests: `TEST_DATABASE_URL=postgresql://mariana:mariana@localhost:5432/<disposable_db> npm run test:db`. It resets that DB, builds the schema, seeds it, then runs every test. The guard in `src/tests/support/test-database-guard.ts` refuses a URL that is unset, equal to `DATABASE_URL`, or on `neon.tech`.
- Every code change starts with a failing regression test. Show it failing, then passing.

## Invariants (never break)
- A lead has at most one active conversation.
- A duplicate inbound event is never processed twice.
- An outbound message that may have been accepted by Meta never goes back to `pending`.
- A message in `unknown` is never resent without evidence.
- The AI is never the authority on IDs, availability or authorization.
- Confirming a slot requires that it equals the persisted `selectedSlotId`.

## Migration freeze
- Do not edit, delete or rename any migration in `drizzle/` that is applied to Neon.
- Do not run `db:migrate`, `db:generate` or `db:push` against Neon. Migration history is under consolidation (see `docs/audit-followup-report.md`); schema changes wait until the approved baseline exists.

## Report format
End every task with:
1. Root cause, with evidence.
2. Files changed, and why.
3. Tests run (with results) and tests not run (with reason).
4. Remaining risks.
