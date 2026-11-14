---
name: verify-request-bound-client
description: Verify DNAForge generated API routing through real Jobs, health and external-lookup callers using two owned HTTP endpoints. Use when changing endpoint binding or request credentials.
---

# Verify request-bound clients

## Launch

From the repository root, install dependencies with `pnpm install --frozen-lockfile` if absent. The workflow starts two real Node HTTP servers on OS-assigned loopback ports and calls the production Jobs store, service managers, external sequence importer and generated API functions. No Python service, desktop profile or external provider is needed for this transport boundary.

```sh
mkdir -p ../.agent-evidence
CLIENT_EVIDENCE_DIR=$(mktemp -d "$(cd .. && pwd)/.agent-evidence/request-bound-client.XXXXXX")
export CLIENT_EVIDENCE_DIR
```

## Doctor

```sh
git rev-parse --show-toplevel HEAD
pnpm --dir apps/desktop exec node -e "console.log(process.version); console.log(require.resolve('vitest/package.json'))"
```

Verify the checkout is the intended source. Ports are reserved by the workflow's own servers, so another desktop instance is never targeted.

## Drive

```sh
git rev-parse HEAD > "$CLIENT_EVIDENCE_DIR/commit.txt"
git diff -- packages/core/api-client apps/desktop/src > "$CLIENT_EVIDENCE_DIR/source.patch"
pnpm --dir apps/desktop exec vitest run src/services/request-bound-client.workflow.test.ts --reporter=verbose --reporter=json --outputFile="$CLIENT_EVIDENCE_DIR/results.json" > "$CLIENT_EVIDENCE_DIR/drive.log" 2>&1
CLIENT_DRIVE_EXIT=$?
printf '%s\n' "$CLIENT_DRIVE_EXIT" > "$CLIENT_EVIDENCE_DIR/exit-code.txt"
cat "$CLIENT_EVIDENCE_DIR/drive.log"
test "$CLIENT_DRIVE_EXIT" -eq 0
```

Read [routing](features/routing.md). Preserve failed runs separately. A green pure helper test does not replace the real caller workflow.

## Evidence

Keep source identity, complete transcript, JSON result and exit code. The actual server captures paths, request headers and bodies; assertions compare them with the endpoint returned to each caller. Only Electron's URL lookup and the remote HTTP transport boundary are substituted. The remote-domain case forwards to an owned loopback server after checking the original destination; it never contacts the `.invalid` hostname. Credentials are synthetic, and the receiving server proves they were stripped. This qualifies routing and request isolation, not live provider content or desktop appearance.

## Cleanup

`afterEach` closes every owned server and connection, restores globals and resets the test store. It runs after failures too. No processes or persistent profiles are started. Evidence remains outside the worktree:

```sh
test -s "$CLIENT_EVIDENCE_DIR/drive.log"
test -s "$CLIENT_EVIDENCE_DIR/results.json"
printf '%s\n' "$CLIENT_EVIDENCE_DIR"
```

## Helpers

`apps/desktop/src/services/request-bound-client.workflow.test.ts` is the executable workflow, invoked with the repository's existing Vitest runner above.
