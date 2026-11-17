---
name: verify-canvas-document-types
description:
  Verify DNAForge canvas document identity, editor/save selection, legacy
  session restoration and tab movement through the real desktop and canvas
  store.
---

# Verify canvas document types

## Launch

Use an isolated feature checkout with README dependencies and unused ports in
`apps/desktop/.env.local`. Keep native profile data isolated from an installed
app. Run `DNAFORGE_BACKGROUND_WINDOW=1 pnpm --dir apps/desktop dev` and require
`ELECTRON_DEV_READY`. Do not change source during its initial native
compilation. Keep the window in the background. No remote model or reference
download is used.

## Doctor

Run `node apps/desktop/scripts/dev-single-instance-guard.cjs --status` from the
repository root. Require `ELECTRON_DEV_HEALTHY` or `ELECTRON_DEV_ATTACHED` for
this checkout. The native helper reads that exact renderer/debug endpoint and
records the source commit. An unhealthy or stale instance is not evidence for
this tree.

## Drive

Choose a new absolute evidence directory outside the checkout for each attempt.

```sh
node skills/verify-canvas-document-types/scripts/drive-native.mjs --out /absolute/evidence/before
pnpm --dir apps/desktop test -- src/features/canvas/canvas-document-session.acceptance.test.ts --reporter=verbose --reporter=json --outputFile=/absolute/evidence/before/contract.json > /absolute/evidence/before/contract.txt 2>&1
```

Read the [feature map](features/README.md). The native journey creates a
disposable project through project controls, opens a small sequence and text
file through the file tree, edits and saves text, splits and joins panes, closes
and reopens a tab, then reloads the persisted session. It never changes a canvas
store directly. The deterministic matrix uses the real canvas store, persistence
migration and editor/save projections to cover variants that the representative
native journey does not open. It also checks identity admission and explicit
identity commands.

## Evidence

Keep the original frames, timestamps, MP4, screenshots, native file readback,
canvas identity/save snapshots and `receipt.json`. Save the working diff beside
the source commit. Keep every failed attempt in its original directory.

The native helper requires actual sequence content, text-editor content and
native file bytes, stable document identity after movement/restoration, no page
exception and no failed application HTTP response. Store checks alone do not
qualify the desktop. The native journey qualifies the representative
sequence/text path; other variants are explicitly covered by the deterministic
matrix.

## Cleanup

Run `node apps/desktop/scripts/dev-single-instance-guard.cjs --stop` in this
checkout. Verify its renderer/API/debug ports have stopped, and that the
evidence receipt, frames and video remain. Keep the disposable project and
profile with the evidence. Never stop a different checkout's app.

## Helpers

`scripts/drive-native.mjs` uses the installed Playwright packages and `ffmpeg`.
It closes its CDP connection and recorder after success or failure. Use Maintain
Verification when the tab commands, selectors or persistence policy change.
