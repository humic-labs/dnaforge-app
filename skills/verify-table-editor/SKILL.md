---
name: verify-table-editor
description:
  Verify notebook table insertion, keyboard focus, editing and native
  persistence in an isolated DNAForge desktop development preview.
---

# Verify the table editor

## Launch and doctor

Use a feature checkout with dependencies installed and its own
`apps/desktop/.env.local` ports. Follow the repository README to start it with
`DNAFORGE_BACKGROUND_WINDOW=1 pnpm --dir apps/desktop dev`. Do not drive an
installed app or another checkout's preview.

Run `node apps/desktop/scripts/dev-single-instance-guard.cjs --status`. Continue
only when it reports a healthy owned renderer and its debugging endpoint. The
verification command repeats this check before attaching. Keep the window in the
background.

## Drive

Run from the checkout root:

```sh
node apps/desktop/scripts/check-table-editor.mjs --out /absolute/durable/evidence-directory
```

The command attaches to this checkout's guarded native preview. It creates a
disposable native notebook, then drives slash insertion, row/column entry, table
editing, Save and reopen with actual keyboard events. It also verifies Ctrl+Tab
and Ctrl+Shift+Tab with notebook text and a table cell editor focused. See
[the feature map](features/keyboard.md) for the expected results.

It also opens a synthetic HTML file in the same disposable project and verifies
ordinary Tab plus reserved pane navigation from its sandboxed preview, both with
scripts disabled and with scripts enabled. The enabled-script fixture changes
its own frame name and consumes DOM key events to verify the native route.

## Evidence

The output directory contains `receipt.json` and original screenshots of the
asserted steps. A passing receipt requires the expected focus, dimensions,
contents and native persistence, with no renderer exception. A screenshot alone
does not prove a keyboard interaction.

For changes affecting responsiveness or focus timing, also retain original
before-and-after native video of the same workflow, along with the actual source
identities and measurements. Keep evidence outside disposable checkouts.

## Cleanup

The command disconnects its debugging session and preserves its evidence and
fixture notebook. It does not stop the app. When the task's preview is no longer
needed, stop only that checkout with
`node apps/desktop/scripts/dev-single-instance-guard.cjs --stop`. Never stop
another checkout or the installed app. Verify that the original evidence remains
after cleanup.
