---
name: verify-sidecar-lifecycle
description: Verify DNAForge desktop compute-service supervision, readiness failures, restart recovery and shutdown using the production supervisor with isolated child processes.
---

# Verify sidecar lifecycle

## Launch

Run from the repository root with Node and pnpm installed. Use `pnpm install --frozen-lockfile` once if dependencies are absent. This workflow imports the real desktop supervisor and session authority. Its existing executable-resolution boundary substitutes a tiny Node HTTP service for Python; it launches real owned children and uses real loopback health requests. It exercises supervision, not Python scientific capabilities or Electron rendering.

```sh
mkdir -p ../.agent-evidence
SIDECAR_EVIDENCE_DIR=$(mktemp -d "$(cd .. && pwd)/.agent-evidence/sidecar-lifecycle.XXXXXX")
export SIDECAR_EVIDENCE_DIR
```

Each drive starts and tears down its own temporary profile, OS-assigned port and child processes. No existing desktop instance is driven.

## Doctor

```sh
git rev-parse --show-toplevel HEAD
pnpm --dir apps/desktop exec node -e "console.log(process.version); console.log(require.resolve('vitest/package.json'))"
```

Confirm this is the intended branch. The test's fresh profile and port reservation are the ownership boundary. Failure to load the actual supervisor is a failed drive, not permission to substitute a copied model.

## Drive

```sh
git rev-parse HEAD > "$SIDECAR_EVIDENCE_DIR/commit.txt"
git diff -- apps/desktop/src/main/sidecar.ts apps/desktop/src/main/sidecar-session-authority.ts apps/desktop/src/main/sidecar-request-auth.ts > "$SIDECAR_EVIDENCE_DIR/source.patch"
pnpm --dir apps/desktop exec vitest run src/main/sidecar-lifecycle.workflow.test.ts src/main/sidecar-session-authority.test.ts src/main/sidecar-request-auth.test.ts --reporter=verbose > "$SIDECAR_EVIDENCE_DIR/drive.log" 2>&1
SIDECAR_DRIVE_EXIT=$?
printf '%s\n' "$SIDECAR_DRIVE_EXIT" > "$SIDECAR_EVIDENCE_DIR/exit-code.txt"
cat "$SIDECAR_EVIDENCE_DIR/drive.log"
test "$SIDECAR_DRIVE_EXIT" -eq 0
```

Do not hide a failed before run. Preserve its log separately from subsequent runs. See [lifecycle](features/lifecycle.md) for the exact observable assertions.

## Evidence

Retain commit, source patch, complete transcript and exit code. The workflow records actual child start/exit/restart events. Assertions check public status, the canonical session, renderer status delivery, readiness promise settlement, authenticated HTTP response, changed child identity and port closure. Tokens never enter artifacts. Only existing external boundaries are substituted: executable resolution, Electron host, telemetry, credential/profile reclamation and crash-loop admission. Restart backoff and poll timers advance under a fake clock; network and child events remain real. This does not qualify packaged startup, Python imports, native genome capabilities or UI appearance.

## Cleanup

The workflow `afterEach` calls the production `killSidecar`, awaits owned process exit and removes its temporary directory even when assertions fail. It never kills by name or touches another profile. After the command exits, retain the evidence directory:

```sh
test -s "$SIDECAR_EVIDENCE_DIR/drive.log"
test -f "$SIDECAR_EVIDENCE_DIR/exit-code.txt"
printf '%s\n' "$SIDECAR_EVIDENCE_DIR"
```

If the runner is externally killed, use the PIDs and exact temporary directory from its transcript to investigate ownership before cleanup. Do not kill unrelated Node or Electron processes.

## Helpers

The executable workflow is `apps/desktop/src/main/sidecar-lifecycle.workflow.test.ts`, invoked above through the existing Vitest runner. No additional daemon or credentials are required.
