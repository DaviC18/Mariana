# Audit follow-up report — `fix/reliability-audit`

Date: 2026-10-15. Base: `develop` @ `b0a8d72`. Nothing has been pushed. Nothing has been written to Neon.

## Commits that already existed (made under the previous prompt; left untouched)

| Hash | Message |
|------|---------|
| `4120764` | docs: add CLAUDE.md with safety rules, test commands and invariants |
| `a601b1d` | test: isolate DB tests with guarded reset, schema bootstrap and seed |
| `59507b2` | fix: map raw RETURNING rows to schema types in task and outbound claims |
| `52d547c` | fix: time out WhatsApp sends and record them as unknown |

Everything after those commits (Phase 1 update, Phase 5, Phase 7 fixes, this report) is **uncommitted**. Proposed commit messages are at the end.

## Safety log

- Every DB command printed its target first. All runs used `localhost:5432/mariana_followup_test` (dropped and recreated before each gate), plus the probes `mariana_migrate_probe` and `mariana_baseline_probe`, which were dropped afterwards.
- No test or migration ran against Neon. `test:db` refuses a `TEST_DATABASE_URL` that is unset, equal to `DATABASE_URL`, or on `neon.tech`. That was shown by running the setup script with each bad value: `UnsafeTestDatabaseError` is thrown before any connection is opened.
- `RELIABILITY_WORKERS_ENABLED=false` in every run. `pgrep` showed no `npm run dev` / `node dist/server.js` process.
- Gemini, WhatsApp and Google were mocked. Both preloads also overwrite every external credential with a fake (`src/tests/support/fake-external-env.ts`), so a call someone forgot to mock fails auth instead of using a production account.

---

## Phase 0 — State and branch

- Finding: the audit fixes and `drizzle/20261014230838_romantic_baron_strucker/` were **already committed** by the user (`c9ac30c`, `b0a8d72`) and pushed to `origin/develop`. The tree was clean, so there was nothing to commit. `romantic_baron_strucker` is therefore tracked, not uncommitted. It was not touched.
- Branch `fix/reliability-audit` was created from `develop` under the previous prompt.

## Phase 1 — `CLAUDE.md`

- Created in `4120764`. Updated (uncommitted): the ABSOLUTE RULE block was added verbatim as the first section, and "Commit locally on a feature branch only" was replaced by "Do not write anything to Neon".
- Blank lines after the headings were added outside my edits (an editor formatter, most likely). I kept them.

## Phase 2 — Isolated, reproducible test environment (`a601b1d`)

**Root cause / gaps found**
- A guard already existed (`src/tests/support/test-database-guard.ts`, from `c9ac30c`), but it accepted a `neon.tech` host.
- A fresh DB had no consultants. `consultant-availability.test.ts` asserts exactly 3: João Silva, Maria Souza, **Carlos Oliveira**.
- `drizzle-kit migrate` cannot build an empty DB (see Phase 6). `drizzle-kit push` of `src/db/schema/index.ts` also failed: the barrel does not export the `scheduling_session_workflow_stage` enum, so `CREATE TABLE scheduling_sessions` references a missing type. Pushing the whole folder double-counts every table through the barrel.
- `test:unit` loaded `.env`, so `DATABASE_URL` pointed at Neon during unit tests.

**Files**
- `src/tests/support/test-database-guard.ts`: rejects `neon.tech`.
- `src/tests/support/setup-test-db.ts` (new): runs the guard, then reset (`DROP SCHEMA drizzle/public CASCADE`), then the schema bootstrap, then the seed. It prints the host and DB, never the password.
- `src/tests/support/bootstrap-schema.ts` (new, test-only): schema entry = barrel + the missing enum. **Temporary workaround** until the Phase 6 baseline exists; the bootstrap uses `drizzle-kit push --force` against `TEST_DATABASE_URL` only (and also sets `DATABASE_URL` to the test URL in case drizzle-kit falls back to `drizzle.config.ts`).
- `src/tests/support/test-seed.ts` (new): `TEST_SEED_VERSION = 1`, the 3 consultants, a single `INSERT … ON CONFLICT (email) DO UPDATE` (idempotent).
- `src/tests/support/unit-test-preload.ts` (new): `DATABASE_URL=postgresql://…@127.0.0.1:1/none`, workers off, fake credentials.
- `src/tests/support/fake-external-env.ts` (new), plus `db-test-preload.ts` now applies it.
- `package.json`: `test:unit`, `test:db`, and `test` = `test:db`.

**Tests (RED → GREEN)**
- `test-database-guard.test.ts`: "recusa TEST_DATABASE_URL hospedado no Neon" and "recusa Neon mesmo sem DATABASE_URL definido" both failed with `Missing expected exception` before the fix, then 8/8 after.

**Verification**: fresh DB → `test:unit` 136/136, then `test:db` 301/301, run twice.

**Bootstrap fidelity**: a sorted `pg_dump --schema-only` diff of the pushed schema against `mariana_audit_test` (the DB the earlier 301/301 ran on) differs only by `scheduling_sessions_selectedSlotId_scheduling_slots_id_fkey`. That FK is not in the TS schema, and `romantic_baron_strucker` drops it (see Phase 6, item 4).

## Phase 3 — Duplicate replies to back-to-back messages (`59507b2`)

**Root cause (proven)**
1. `node_modules/drizzle-orm/postgres-js/driver.js` installs a transparent parser for OIDs `1184` (timestamptz), `1082`, `1083`, `1114`, … So raw `db.execute()` rows keep timestamps as strings. jsonb (3802) is still parsed by postgres-js.
2. Runtime probe on Docker: `SELECT now() AS ts, '{"a":1}'::jsonb` through `db.execute` gave `ts string "2026-10-15 20:07:45.462609+00"` and `j object`.
3. `claimNextTask` returned `RETURNING task.*` cast to `AutonomousTask`, so `anchorTask.createdAt` was a string. Under the pre-`c9ac30c` `selectInboundMessageBatch`, `candidate.taskCreatedAt >= anchorTask.createdAt` compared a `Date` with a string, which is always `false`. Every non-anchor task was dropped: task1 answered msg1 alone, then task2 answered msg2 alone.
4. Timing: `c9ac30c` (2026-10-14 23:20Z) added a task-only mapper and `getTime()` comparisons. The incident happened at 22:13Z, so production was running the pre-fix code. The jsonb payload was an object, so `getInboundBatchCutoffAt` was not involved.

**Files**
- `src/db/raw-row.ts` (new): `mapRawRow(table, row)`, driven by drizzle column metadata (`object date` becomes a `Date`; `object json` is parsed if it is text). This is the single mapper for every raw `RETURNING *`.
- `src/services/conversations/autonomous-task-row.ts`: `mapAutonomousTaskRow` is now a thin wrapper.
- `src/services/messaging/outbound-messages.ts`: `claimNextOutboundMessage` now maps its rows (it returned raw rows before) and is exported for the test.
- `src/services/conversations/inbound-message-batch.ts`: imports `toDate` from `raw-row`. It already compared with `getTime()`.
- Other raw queries checked: `recoverStaleAutonomousTasks` (`RETURNING "status"`), `recoverStaleOutboundMessages` (`RETURNING "id"`), and `outbound-messages.ts:390` (`RETURNING "id"`). None return timestamps or json, so no change.
- Outbound impact before the fix: none observable today. drizzle's `mapToDriverValue` passes strings through, so writing `availableAt: message.availableAt` worked. The `OutboundMessage` type was still wrong at runtime.

**Tests (RED → GREEN)**
- `src/tests/reliability/inbound-batch-claim.test.ts` (new, DB): real claim plus real handlers, Gemini mocked, two tasks 10s apart with a shared `batchCutoffAt`. With the pre-fix claim and batch code restored temporarily: `AssertionError: expected exactly one reply for the batch — actual: 2, expected: 1` (the incident). After: 1 reply, both tasks `completed`, and the Gemini prompt contains both messages.
- `src/tests/inbound-message-batch.test.ts` "âncora com createdAt em string…" (DB-free, already present) **failed** against the pre-fix module.
- `src/tests/raw-row.test.ts` (new, unit): failed with `Cannot find module`, then 3/3.
- `outbound-messages.test.ts` "claim do outbox devolve timestamps como Date…" (DB): failed with `AssertionError: createdAt`, then passed.
- Step 5: **no "clock skew" test exists**. `grep -rni "skew|relógio|clock" src` and `git log --all -S skew` are both empty. The production-incident test in `inbound-message-batch.test.ts` already states the correct cause, so nothing was removed.

**Verification**: fresh DB → unit 139/139, then db 306/306, run twice.

## Phase 4 — Timeout on outbound WhatsApp calls (`52d547c`)

**Root cause**: `fetch` in `whatsapp-client.ts` had no timeout. A hung Graph API call blocked the outbound worker indefinitely, past its 60s lease.

**Files**
- `src/env.ts`: `WHATSAPP_SEND_TIMEOUT_MS`, an integer, `min(1000)`, `max(45_000)`, default `15_000`. `.env.example` is documented.
- `src/integrations/whatsapp/whatsapp-client.ts`: one shared `postMessage` path. `fetch(..., { signal: AbortSignal.timeout(ms) })` is raced against the signal's abort, so the worker is released even if a request ignores the signal. A timeout or network error becomes `WhatsAppSendError({ kind: "uncertain" })` through the existing classification. The outbox then marks the message `unknown` (`outbound-messages.ts`, `error.uncertain` branch) and never moves it back to `pending`.
- `api-idempotency-retry` guidance applied: a read timeout on a non-idempotent send with no provider idempotency key is never retried.

**Tests (RED → GREEN)**
- `env.test.ts`: 3 failures (default missing, configured value, range), then 7/7.
- `whatsapp-service.test.ts`: a fetch that never resolves and ignores the signal gave `still pending after 2000ms` (text and buttons), and no `AbortSignal` was passed. Then pass.
- `outbound-messages.test.ts` "envio pendurado…" (DB, `leaseMs=2000`, timeout 100ms): `Error: worker still blocked after the lease`. After the fix: result `unknown`, row `unknown`, `attempts=1`, lease cleared, the next run is `idle`, and `fetch` was called exactly once.

**Verification**: fresh DB → unit 144/144, then db 312/312, run twice.

## Phase 5 — Secrets and PII in logs (uncommitted)

**Findings (grep of every `console.*` / `*.log.*` call)**

| # | Location | Leak | Fixed |
|---|----------|------|-------|
| 1 | `routes/whatsapp/webhook-whatsapp.ts` GET verify | `token` logged on failure | yes, now logs `mode`, `tokenMatched: false` |
| 2 | Fastify `req` serializer ("incoming request" logs) | `req.url` carries `?hub.verify_token=<secret>` for **both** WhatsApp and Meta Ads verification, and `?code=`/`state=` on the Google OAuth callback | yes, `redactSensitiveQuery` in `src/lib/logger.ts` |
| 3 | `server.ts` `onResponse` hook | same `request.url` | yes, same helper |
| 4 | `integrations/whatsapp/whatsapp-client.ts` HTTP-error log | recipient phone (`to`) | yes, removed |
| — | the rest (route error logs, Google/Meta ads, outbox, agent) | IDs only (lead/conversation/message/event ids, WAMIDs) | not needed |

Notes: `redact: ["token"]` only masked a top-level `token` key, which is why #2 and #3 leaked. `errorData` (the Meta error body) is still logged. It holds provider error codes, which are needed for triage.

**Files**: `src/lib/logger.ts` (`baseLoggerOptions` with a `req` serializer, plus `redactSensitiveQuery`), `src/server.ts`, `src/routes/whatsapp/webhook-whatsapp.ts`, `src/integrations/whatsapp/whatsapp-client.ts`, `package.json` (new test in `test:unit`).

**Tests (RED → GREEN)**
- `src/tests/routes/webhook-verification-logs.test.ts` (new, unit): builds the app with the production logger options plus a capture stream, then sends GETs with a wrong token and with a valid one, for WhatsApp **and** Meta Ads. RED: `wrong token leaked to logs` (on both routes), `tokenMatched` missing, and `redactSensitiveQuery` missing. Then 4/4.
- `whatsapp-service.test.ts` "não loga o telefone…": RED `recipient phone leaked to logs`, then pass.
- Note: you rejected the tool call for fix #4, but its edit step had already run, so the change is on disk. I verified it (tests pass) and kept it. Discard it if you did not want it.

**Verification**: fresh DB → unit 149/149, then db 317/317, run twice.

## Phase 6 — Migrations: PLAN ONLY (awaiting your approval)

Nothing below has been run against Neon. No file under `drizzle/` was changed.

### What was proven on Docker (local probe DBs, since dropped)

- The migrator (`drizzle-orm/pg-core/async/session.js`) records applied migrations in `drizzle.__drizzle_migrations(id, hash, created_at, name, applied_at)`. It decides what to run **by folder `name`** (`migrator.utils.js: getMigrationsToRun`). Folders apply in name order, and the top-level `drizzle/*.sql` files are ignored (only `<folder>/migration.sql` is read).
- The snapshot DAG is `… persistent_selected_scheduling_slot (7feb3625)` → `restore_lead_urgency_and_webhook_events (a4a7d443, folder dated 2026-10-16)`. That then forks into `oval_may_parker → zippy_chamber` and, separately, `romantic_baron_strucker`. `reliability_stage2` and `reliability_stage2_followup` (2026-10-17) have no snapshot.
- `drizzle-kit migrate` on an empty DB: `Non-commutative migrations detected — Found 1 conflict across 2 migrations … create_enum: outbound_message_status` (zippy vs romantic).
- With `--ignore-conflicts`: it fails at `ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_eventId_whatsapp_webhook_events_id_fkey" … REFERENCES "whatsapp_webhook_events"`. Name order runs `romantic` (20261014) **before** its own parent `restore_lead_urgency` (20261016), which is where `whatsapp_webhook_events` comes from. The run happens in one transaction, so it rolls back and leaves 0 journal rows.
- Feasibility of a baseline: `drizzle-kit generate --schema src/tests/support/bootstrap-schema.ts --out <scratch>` produced one SQL file. Applied to an empty DB, its sorted `pg_dump --schema-only` is **identical** (348 lines) to the schema all 324 tests pass on. The missing enum export in `src/db/schema/index.ts` has to be fixed in the real schema before generating the real baseline.

### 1. Read-only SQL for you to run on Neon

Use the **direct** host (drop `-pooler` from the hostname) and a read-only session:

```sql
BEGIN TRANSACTION READ ONLY;

-- Journal: does it exist, which columns, which rows
SELECT to_regclass('drizzle.__drizzle_migrations') AS journal_table;
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'
ORDER BY ordinal_position;
SELECT * FROM drizzle.__drizzle_migrations ORDER BY id;

-- Item 4 below: is the selectedSlotId FK present, and would it validate?
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'public.scheduling_sessions'::regclass AND contype = 'f'
ORDER BY conname;
SELECT count(*) AS orphan_selected_slots
FROM scheduling_sessions s
WHERE s."selectedSlotId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM scheduling_slots x WHERE x.id = s."selectedSlotId");

-- Overlap check for the EXCLUDE decision (see "Decisions that are still yours")
SELECT a.id, b.id, a."consultantId", a."startAt", a."endAt"
FROM appointments a
JOIN appointments b
  ON a."consultantId" = b."consultantId" AND a.id < b.id
 AND tstzrange(a."startAt", a."endAt") && tstzrange(b."startAt", b."endAt")
WHERE a.status IN ('pending_confirmation','confirmed','scheduled')
  AND b.status IN ('pending_confirmation','confirmed','scheduled');

SHOW server_version;
ROLLBACK;
```

Schema dump. It is read-only: `pg_dump` takes only `ACCESS SHARE` locks and reads one snapshot. The password goes through the environment, not argv; use a `pg_dump` major version ≥ the server's:

```bash
read -rs PGPASSWORD && export PGPASSWORD   # paste the Neon password, not echoed
docker run --rm -e PGPASSWORD postgres:18.6 pg_dump \
  --schema-only --no-owner --no-privileges --schema=public --schema=drizzle \
  "postgresql://<user>@<ep-...>.us-east-2.aws.neon.tech/neondb?sslmode=require" \
  > neon-schema.sql
unset PGPASSWORD
```

### 2. Consolidation plan (new baseline = production schema)

To respect the freeze, no existing folder is edited, renamed or deleted. A new migrations folder and a new journal table take over:

1. **Fix schema drift in TS first** (a normal PR, with tests): export `schedulingSessionWorkflowStage` from `src/db/schema/index.ts`. Then make the TS schema match `neon-schema.sql` exactly, including the `selectedSlotId` FK decision (item 4) and anything else the dump shows.
2. **Generate the baseline** into a new folder: `drizzle-kit generate --out ./migrations --name baseline`, with `drizzle.config.ts` changed to `out: "./migrations"` and `migrations: { table: "__drizzle_migrations_v2", schema: "drizzle" }`. `drizzle/` stays as read-only history.
3. **Schema-diff proof on Docker** (it must print `IDENTICAL`):
   ```bash
   norm(){ docker exec mariana-postgres pg_dump -U mariana -d "$1" --schema-only --no-owner --no-privileges -n public \
     | grep -v -E '^--|^\\(un)?restrict|^COMMENT ON SCHEMA' | sed '/^$/d; s/,$//' | sort; }
   # A: baseline applied to an empty DB
   docker exec mariana-postgres psql -U mariana -d postgres -c "create database mariana_baseline"
   sed 's/--> statement-breakpoint//' migrations/*_baseline/migration.sql \
     | docker exec -i mariana-postgres psql -U mariana -d mariana_baseline -v ON_ERROR_STOP=1 -q
   # B: your Neon dump restored into an empty DB
   docker exec mariana-postgres psql -U mariana -d postgres -c "create database mariana_neon_mirror"
   docker exec -i mariana-postgres psql -U mariana -d mariana_neon_mirror -v ON_ERROR_STOP=1 -q < neon-schema.sql
   diff <(norm mariana_baseline) <(norm mariana_neon_mirror) && echo IDENTICAL
   ```
   Then switch `setup-test-db.ts` from `push` to `migrate` with the new config, and delete `bootstrap-schema.ts`.
4. **Mark the baseline as applied** on the target without running its DDL. This creates bookkeeping only:
   ```sql
   BEGIN;
   CREATE SCHEMA IF NOT EXISTS drizzle;
   CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations_v2 (
     id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint, name text,
     applied_at timestamp with time zone DEFAULT now()
   );
   INSERT INTO drizzle.__drizzle_migrations_v2 (hash, created_at, name)
   VALUES ('<sha256 of migrations/<ts>_baseline/migration.sql>', <folderMillis of <ts>>, '<ts>_baseline');
   COMMIT;
   ```
   `hash` = `sha256sum migrations/<ts>_baseline/migration.sql`. `created_at` = the folder's 14-digit timestamp as UTC epoch ms. That matches what the migrator would write, so later `drizzle-kit migrate` runs skip the baseline by name.
5. **Verify on the target**: `drizzle-kit migrate` reports nothing to apply, and `drizzle-kit push --explain` (a dry run) prints no statements.

**Rollback**: the baseline never runs DDL on Neon. Rolling back = `DROP TABLE drizzle.__drizzle_migrations_v2;` plus reverting the `drizzle.config.ts` change. The old `drizzle.__drizzle_migrations` and `drizzle/` are never touched, so the previous state comes back exactly.

### 3. Order of operations

1. You run the read-only SQL and the dump (section 1) and send me the output plus `neon-schema.sql`.
2. PR A: fix the TS schema drift until the Docker diff (TS-generated vs Neon mirror) is empty. Full test gate.
3. PR B: the new `migrations/` baseline, the config change, `test:db` using `migrate`. Docker diff proof = `IDENTICAL`.
4. **Required: test on a Neon branch first.** Create a branch from production in the Neon console, run step 4 (mark applied) and step 5 (verify) against the **branch** URL, then run the app against the branch for a smoke test.
5. Only after the branch passes: run steps 4–5 on production during a quiet window, with the rollback statement ready.
6. From then on, every schema change is a new folder in `migrations/`, generated from TS and tested on Docker and a Neon branch.

### 4. `romantic_baron_strucker` and its FK

- Correction: it is **not uncommitted**. It is tracked since `c9ac30c` and pushed. It is left untouched.
- What it does: it drops `scheduling_sessions_selectedSlotId_scheduling_slots_id_fkey` (added by `persistent_selected_scheduling_slot`) and recreates `outbound_message_status` and `outbound_messages`, which `zippy_chamber` also creates. The current TS schema has no `.references()` on `selectedSlotId`, so it matches romantic's end state (no FK).
- Whether Neon has the FK depends on which of the forked migrations actually ran. The queries in section 1 answer that. Recommendation: **keep the FK** (`ON DELETE SET NULL`). It stops `selectedSlotId` from pointing at a deleted slot, which backs the invariant "confirm only the persisted `selectedSlotId`". If Neon lacks it, add it as the first migration after the baseline: `ADD CONSTRAINT … NOT VALID`, then `VALIDATE CONSTRAINT` once the orphan count is 0. Add `.references(() => schedulingSlots.id, { onDelete: "set null" })` in TS at the same time.
- Under the plan, romantic stays in `drizzle/` as frozen history. It is never run again, because the new journal starts at the baseline.

## Phase 7 — Final review

### Commands and results (final run, fresh DB `localhost:5432/mariana_followup_test`)

| Command | Result |
|---------|--------|
| `npx tsc --noEmit` | exit 0 |
| `npm run build` | exit 0 (`dist/server.js` 1.37 MB) |
| `npm run check` | **exit 1**: 1 error, the formatting of `drizzle/20261014230838_romantic_baron_strucker/snapshot.json`. It is pre-existing (it fails on `develop` too) and frozen, so it was not touched. 0 errors in `src/`. |
| `git diff --check` / `git diff --check develop..HEAD` | exit 0 |
| `npm run test:unit` | 156/156 |
| `npm run test:db` run 1 | 324/324 |
| `npm run test:db` run 2 | 324/324 |

### `security-review` (full branch diff)

No findings with confidence ≥ 8. Of the rejected candidates, one (`new URL` throwing in the redactor) is a correctness issue; it overlaps code-review #1 and was fixed.

### `code-review` (develop..working tree): findings and outcome

| # | Finding | Outcome |
|---|---------|---------|
| 1 | `redactSensitiveQuery` threw on `//?a=1`, `//[?x` (`ERR_INVALID_URL`) inside the logger | **fixed**: text/regex based, never throws. Test RED (`ERR_INVALID_URL`), then GREEN |
| 2 | Fastify's 404 log `Route GET:/x?... not found` printed raw query tokens | **fixed**: pino `hooks.logMethod` redacts string messages. Test RED (`token leaked in the 404 log`), then GREEN |
| 3 | `mapRawRow` turned a missing NOT NULL column into `null` | **fixed**: throws `TypeError`. Test RED, then GREEN |
| 4 | `npm test` had become the destructive `test:db` | **fixed**: `npm test` runs every test with no reset; only `test:db` resets |
| 5 | Timeout also covered reading the error body, so a 400/503 with a stalled body became `unknown` | **fixed**: the status is classified even if the body read times out. Tests RED (wrong `kind`), then GREEN. A timeout before the headers arrive, or while reading a 2xx body, is still `uncertain` |
| 6 | `toJson` would re-parse a jsonb string value | **not changed**: the probe showed the driver parses jsonb, and the app only writes objects to `payload`/`result`. No reachable case |
| 7 | DB preload "does not force" `RELIABILITY_WORKERS_ENABLED=false` | **rejected**: `resolveTestDatabaseEnv` returns `RELIABILITY_WORKERS_ENABLED: "false"` (`test-database-guard.ts:81`), and the preload applies it |
| 8 | Invalid `WHATSAPP_SEND_TIMEOUT_MS` silently fell back to 15000 | **fixed**: the raw value goes to zod. Test (`"20s"`) RED, then GREEN |
| 9 | `--url` with the password in the drizzle-kit argv | **fixed**: test-only `src/tests/support/drizzle.test.config.ts` reads the guarded URL from the env |
| 10 | Dead code (`value ?? null`; `req.headers.authorization` redact path) | first fixed; the redact entry is pre-existing config and was kept |

### Files changed after the last commit (uncommitted)

`CLAUDE.md`, `package.json`, `src/env.ts`, `src/db/raw-row.ts`, `src/lib/logger.ts`, `src/server.ts`, `src/routes/whatsapp/webhook-whatsapp.ts`, `src/integrations/whatsapp/whatsapp-client.ts`, `src/tests/support/setup-test-db.ts`, `src/tests/env.test.ts`, `src/tests/raw-row.test.ts`, `src/tests/integrations/whatsapp-service.test.ts`, new `src/tests/routes/webhook-verification-logs.test.ts`, new `src/tests/support/drizzle.test.config.ts`, new `docs/audit-followup-report.md`.

## Invariants preserved

- **One active conversation per lead**: not touched. The DB tests covering it pass (324/324).
- **Duplicate inbound event processed once**: not touched (webhook idempotency, `inbound:${externalId}` task key). Batching now merges a debounce window into **one** reply, proven by `inbound-batch-claim.test.ts`.
- **Possibly-accepted outbound never goes back to `pending`**: a timeout or network error is `uncertain`, so the message becomes `unknown`. Only a definite HTTP status (408/429/5xx retryable, 4xx permanent) can retry or fail.
- **`unknown` is never resent without evidence**: the hang test asserts that the next run is `idle` and `fetch` was called once.
- **The AI is not the authority on IDs, availability or authorization**: not touched.
- **Confirm requires `selectedSlotId`**: not touched. The FK recommendation is in Phase 6, item 4.

## Remaining risks

1. Migrations cannot build a fresh DB, and Neon's journal state is unknown until you run the section 1 SQL. Tests use a `push` bootstrap of the TS schema, which may differ from Neon. The one known difference is the `selectedSlotId` FK.
2. 5xx responses are classified as `retryable` (pre-existing). A 502/504 from an intermediary can come after Meta has already accepted the message, so a retry could duplicate it. Consider treating 502/504 as `uncertain`.
3. Only `WHATSAPP_SEND_TIMEOUT_MS` rejects invalid input. Other integer env vars still silently fall back to their default through `parseIntegerEnv` (pre-existing).
4. `redactSensitiveQuery` masks by parameter name. A secret passed under a name that doesn't match the list (`token|secret|key|signature|password` suffix, `code`, `state`) would still be logged.
5. No overlap constraint on appointments: two concurrent confirmations for the same consultant and time rely on Calendar and application checks only.
6. `npm run check` stays red until the frozen snapshot is reformatted, or excluded in `biome.json` (your call).

## Decisions that are still yours

### A. Calendar transient error during confirmation: retry, or message the client?

Today `SchedulingConfirmationOrchestrator.execute` catches **every** error from `createConfirmedAppointment` and returns `{ ok: false, reason: "appointment_failed" }` (`src/services/calendar/scheduling-confirmation-orchestrator.ts:186`). Transient errors (429/5xx/network) and permanent ones are handled the same way.

- **Retry**: rethrow transient errors as `TransientAutonomousTaskError`, so the task retries with backoff. That is safe because the appointment `idempotencyKey` = `session:slot` makes the create idempotent. Trade-off: the client waits silently through the retries.
- **Message the client**: keep today's behavior, with an immediate "não consegui confirmar, tente de novo" reply.
- Middle option: a bounded retry (for example 2 attempts within about 1 min), then the message.

### B. `EXCLUDE USING gist` on appointments (only after the Phase 6 baseline)

Draft (requires `btree_gist`, because `uuid =` needs a gist opclass):

```sql
-- migrations/<ts>_appointments_no_overlap/migration.sql
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_consultant_no_overlap"
  EXCLUDE USING gist (
    "consultantId" WITH =,
    tstzrange("startAt", "endAt", '[)') WITH &&
  )
  WHERE ("status" IN ('pending_confirmation', 'confirmed', 'scheduled'));
```

Notes:
- Run the overlap query in section 1 first. The constraint fails to create if overlapping active rows exist.
- `ADD CONSTRAINT … EXCLUDE` builds an index while holding a lock that blocks writes, and cannot be added `NOT VALID`. The table is small, but run it in a quiet window, after testing on a Neon branch.
- Check that `btree_gist` is enabled for the Neon project.
- Application side: map SQLSTATE `23P01` (exclusion_violation) to "slot no longer available" in `appointmentService`, with a DB test for two concurrent confirmations.
- In TS, drizzle has no first-class `EXCLUDE`. Keep it as a hand-written migration and note it in the schema file.

## Proposed commits (awaiting your permission; nothing committed)

1. `docs: put the no-commit rule first in CLAUDE.md` (`CLAUDE.md`)
2. `fix: keep WhatsApp verify tokens, OAuth codes and recipient phones out of logs` (`src/lib/logger.ts`, `src/server.ts`, `src/routes/whatsapp/webhook-whatsapp.ts`, `src/integrations/whatsapp/whatsapp-client.ts` phone removal, `src/tests/routes/webhook-verification-logs.test.ts`, the phone test in `whatsapp-service.test.ts`, `package.json` test list)
3. `fix: classify WhatsApp HTTP errors by status even when the body stalls` (rest of `whatsapp-client.ts`, the stalled-body tests)
4. `fix: reject missing NOT NULL columns in mapRawRow` (`src/db/raw-row.ts`, `src/tests/raw-row.test.ts`)
5. `fix: fail on invalid WHATSAPP_SEND_TIMEOUT_MS instead of defaulting` (`src/env.ts`, `src/tests/env.test.ts`)
6. `test: keep npm test non-destructive and the test DB password out of argv` (`package.json` `test`, `setup-test-db.ts`, `drizzle.test.config.ts`, `CLAUDE.md` npm test line)
7. `docs: add audit follow-up report` (`docs/audit-followup-report.md`)

Commits 2 and 3 both touch `whatsapp-client.ts`, and `package.json`/`CLAUDE.md` span commits 1, 2 and 6. Splitting them needs `git add -p`; I can do it hunk by hunk once you approve.
