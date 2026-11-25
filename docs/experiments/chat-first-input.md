# Chat-first input experiment

Chat is the main input route. Keep a small manual interface for quick
corrections and essential creation/import, while retaining the existing output
views.

The shell has Chat, New chat and one Add menu. Add contains New project, Open
project, New notebook, New DNA sequence and Import file. These call the existing
project, document and import owners and use their normal dialogs.

Each output starts in inspection mode. Pointer selection, canvas gestures,
scrolling and keyboard navigation remain available. Authoring controls are
hidden and typing/paste are blocked until the user chooses Edit. Edit reveals
that view's existing controls for a correction; Done editing returns to
inspection. This is progressive disclosure, not a newly restricted document
permission. Save and undo/redo remain available while a manual editor has focus.
The file tree, registry panels and terminal stay out of the shell.

## Run it

Use the Node version and setup in the root README, then:

```sh
VITE_CHAT_FIRST_INPUT=1 node start.mjs
```

This explicit local development flag replaces the earlier AI-only experiment
flag. Hosted and production renderers ignore it. Restart without the variable to
restore the ordinary interface. Saved document formats and permissions do not
change.

The existing in-app agent routes, provider setup and approval flows remain in
use. Auth initialization belongs to this shell even though its account button is
absent, allowing automatic route selection to finish.

## Implementation boundary

The alternate shell reuses the existing canvas, chat and document lifecycle.
Output permissions stay with their native owners. Input-region markers separate
conversation, inspection, manual editing and navigation. The event guard blocks
accidental typing in inspection mode, but permits pointer gestures and explicit
manual inputs. Menus inherit their input region from their anchor, including
portalled menus.

The command dispatcher allows Save and undo/redo when focus is inside a manual
editor. General file creation shortcuts and terminal execution remain excluded;
the compact Add menu calls only its named existing handlers. Native import menus
are omitted to avoid duplicating Add. Native undo/redo respects the focused
input region. Dialog hosts needed for creation, confirmation and import remain
mounted without restoring the normal application panels.

## Earlier experiment and limits

The first version attempted strict AI-only input by making all output contents
inert. That also removed useful inspection. The revised experiment permits quick
edits and essential create/import controls, with chat remaining the default.

Notebook authoring now creates, reads and updates content through the native
notebook owner. Creation receipts retain the request and content identity across
retries. Shared feature activations keep references and conflict recovery
available in the alternate shell. The first literal DNA product can publish the
initial accepted project revision through the normal mutation and recovery
checkpoint. Source-based products retain their exact accepted revision pins.

The native probe and a real Codex chat turn cover notebook and sequence workflows.
Other providers and the remaining scientific document types need separate
verification before broader readiness claims.

## Verify the browser prototype

Start the test-mode renderer in one terminal:

```sh
VITE_CHAT_FIRST_INPUT=1 pnpm --dir apps/desktop exec vite \
  --config vite.renderer.config.ts --mode test \
  --host 127.0.0.1 --port 14636 --strictPort
```

With Google Chrome installed, run:

```sh
node apps/desktop/scripts/probe-chat-first-input.mjs \
  http://127.0.0.1:14636 /tmp/dnaforge-chat-first-probe
```

The probe calls the existing notebook agent tool to create, inspect, edit and
save a synthetic notebook on the in-memory platform. It checks the rendered
output, pointer selection, blocked accidental typing/paste/drop, explicit manual
correction, chat menus, output-tab navigation and the Add project dialog. It
writes a JSON result and screenshot. It refuses to run against a native
renderer.

This is browser presentation and tool/editor proof. It does not prove a live
model turn, native IPC, filesystem persistence or every scientific viewer's
inspection behavior.

Focused checks:

```sh
pnpm --dir apps/desktop test -- \
  src/lib/chat-first-input.test.ts \
  src/components/ChatFirstWorkbench.test.tsx \
  src/components/ChatFirstWorkbench.agent.test.tsx \
  src/commands/CommandScopeProvider.chat-first.test.tsx \
  src/commands/CommandScopeProvider.test.tsx \
  src/components/PortalMenu.test.tsx \
  src/main/__tests__/menu.chat-first.test.ts \
  src/main/__tests__/menu.test.ts \
  src/main/__tests__/menu-import.test.ts
```

## Verify native persistence

Start the development desktop with `VITE_CHAT_FIRST_INPUT=1` using the normal
`pnpm --dir apps/desktop dev` command. Then pass its reported debugging port:

```sh
node apps/desktop/scripts/probe-chat-first-native.mjs \
  http://127.0.0.1:22438 /tmp/dnaforge-chat-first-native
```

This creates a synthetic project through Add, then calls the normal notebook and
sequence authoring services against native IPC. It checks creation retries,
changed requests, stale notebook revisions, first literal DNA publication,
duplicate names, accepted source pins, missing sources, reference opening,
inspection typing, manual saving, independent saved bytes and renderer reload.
It writes results and screenshots outside the repository. The synthetic project
remains available for inspection. This deterministic probe does not send a model
request; a live chat turn must be checked separately.
