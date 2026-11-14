---
name: verify-agent-stop-state
description:
  Verify DNAForge desktop session stopping, terminal observation, recovery and
  continuation through the production manager and file SQLite with provider
  boundary fixtures.
---

# Verify agent stop state

## Launch

From the repository root, use Node and pnpm versions in `.nvmrc` and
`package.json`.

```sh
pnpm install --frozen-lockfile --ignore-scripts
node apps/desktop/scripts/install-test-sqlite.cjs
export AGENT_STOP_EVIDENCE="$(mktemp -d "${TMPDIR:-/tmp}/dnaforge-agent-stop-evidence.XXXXXX")"
```

The SQLite installer must report a verified binding. No Electron window,
backend, provider login or network query is needed. The harness uses the
production `AgentSessionManager` with injected provider queries and real schema,
persistence, terminal telemetry and continuation lookup. Each case owns a
separate temporary database. It does not touch an installed app's profile.

## Doctor

Run from the repository root and retain the result.

```sh
node -e 'const Database=require("better-sqlite3"); const db=new Database(":memory:",{nativeBinding:require("node:path").resolve("apps/desktop/src/main/__tests__/__fixtures__/better_sqlite3_node.node")}); console.log({node:process.version,sqlite:db.prepare("select sqlite_version() as version").get()}); db.close()' > "$AGENT_STOP_EVIDENCE/doctor.txt"
git rev-parse HEAD > "$AGENT_STOP_EVIDENCE/source-commit.txt"
git diff --binary > "$AGENT_STOP_EVIDENCE/source.patch"
```

## Drive

```sh
pnpm --dir apps/desktop test -- src/main/agent-session/__tests__/stop-state.acceptance.test.ts --reporter=verbose --reporter=json --outputFile="$AGENT_STOP_EVIDENCE/results.json" > "$AGENT_STOP_EVIDENCE/drive.txt" 2>&1
```

The mapped [features](features/README.md) cover active Stop, provider-confirmed
and unconfirmed outcomes, pre-admission Stop, late renderer cancellation,
migration, restart recovery and continuation. Success requires all cases to
pass. Keep failed attempts; a failed assertion is evidence, not qualification.

## Evidence

Each case saves a SQLite backup and JSON observation record in
`AGENT_STOP_EVIDENCE`, including durable session and outbox rows. The active
Stop case records the request, intermediate record, missing terminal event and
provider result. Recovery reopens the same file; migration checks unchanged
content and timestamps across repeat schema initialization. The late Stop case
compares the entire committed record before and after the request.

Provider queries and capability discovery are boundary fixtures. These checks
qualify local lifecycle ownership, not actual provider cancellation or desktop
appearance. Do not label them live-model or UI evidence. Terminal outcome and
analytics persistence remain real production code in one SQLite transaction.

## Cleanup

The harness closes and removes only its temporary databases in `afterEach`,
after saving evidence. There is no server to stop. Confirm the report and
backups survive cleanup:

```sh
test -s "$AGENT_STOP_EVIDENCE/results.json"
test -s "$AGENT_STOP_EVIDENCE/active-to-unconfirmed.sqlite"
test -s "$AGENT_STOP_EVIDENCE/legacy-migration.sqlite"
```

Keep the evidence directory outside the checkout. Use Maintain Verification when
these commands or the mapped session behavior changes.
