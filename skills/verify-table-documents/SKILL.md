---
name: verify-table-documents
description:
  Drive native table tabs independently of notebook editors and verify identity,
  Save and legacy-data retention in an isolated DNAForge desktop profile.
---

# Verify table documents

Use the public desktop development launcher and its real Electron renderer. Keep
original captures and receipts outside the checkout.

## Launch

Install dependencies with `pnpm install --frozen-lockfile`. Configure unused
ports in `apps/desktop/.env.local` using its example. Start the task-owned app
with `DNAFORGE_BACKGROUND_WINDOW=1 pnpm --dir apps/desktop dev` in an isolated
automation context. Reuse compatible helper binaries and a Python environment;
do not start or stop another checkout's app or services.

## Doctor

Run `pnpm --dir apps/desktop dev:status`. Require the renderer and CDP addresses
to belong to this checkout. The journey independently checks runtime provenance
before creating its own project under the requested evidence directory.

## Drive

Run
`node apps/desktop/scripts/check-table-documents.mjs --out ABSOLUTE_EVIDENCE_DIRECTORY`.
The driver uses the native project/notebook commands for fixture setup, then
uses visible table insertion, expansion, close, cell editing and Save controls.
Its notebook inspection uses the same native owner as the human editor.

See [the feature map](features/README.md).

## Evidence

Keep `receipt.json`, original screenshots, recording frames when captured,
runtime identity and the fixture project. A passing receipt requires edits and
Save after closing the source notebook, matching native data and saved bytes,
and the same data on reopen. A screenshot alone is insufficient. Baseline
failures remain separate from later passing captures. A renderer reload is not a
process restart; identify which was exercised.

## Cleanup

Run `pnpm --dir apps/desktop dev:stop` only from the owned checkout. Verify its
ports are free and retain the evidence directory and original captures. Keep a
preview running only while it is serving Peter's requested local testing.
