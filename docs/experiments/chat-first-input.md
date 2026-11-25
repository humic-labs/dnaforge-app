# Chat-first input experiment

Chat is the main input route. Keep a small manual interface for quick
corrections and essential creation/import, while retaining the existing output
views.

The title bar shows the selected project. Use its project picker to create, open
or import a project. Files searches the selected project. Import and New
document provide direct access to file import, notebooks and DNA sequences.

An empty workspace opens to chat. Prompt starters fill the composer for review.
Opening a result puts it in the adjacent canvas. The conversation stays visible
and document tabs retain their native close controls and unsaved indicators.

Chat shows the project bound to the conversation. Selecting another project
changes where Files, Import and New document work. Choose New chat to start in
that project. Existing conversations and their drafts stay associated with their
original projects and can be reopened from history.

Make corrections inside the native document view. Notebook edits use its usual
autosave and Save now control. Sequence selection, zoom, maps and native edit
controls remain available beside chat.

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

The alternate shell reuses the existing canvas, chat, project picker and
document lifecycle. The native editors own write access, recovery, save feedback
and conflict handling. The shell starts with chat and keeps general creation
shortcuts and terminal commands outside its command set.

Notebook authoring now creates, reads and updates content through the native
notebook owner. Creation receipts retain the request and content identity across
retries. Shared feature activations keep references and conflict recovery
available in the alternate shell. The first literal DNA product can publish the
initial accepted project revision through the normal mutation and recovery
checkpoint. Source-based products retain their exact accepted revision pins.

The native probe and a real Codex chat turn cover notebook and sequence
workflows. Other providers and the remaining scientific document types need
separate verification before broader readiness claims.

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

The probe exercises the project picker and prompt starters, then calls the
notebook agent tool on the in-memory platform. It checks the rendered output,
pointer selection, direct manual correction, file search and document creation
controls. It writes a JSON result and screenshot. It refuses to run against a
native renderer.

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

This creates a synthetic project through the project picker, then calls the
normal notebook and sequence authoring services against native IPC. It checks
creation retries, changed requests, stale notebook revisions, first literal DNA
publication, duplicate names, accepted source pins, missing sources and
reference opening. It also exercises the native notebook editor, verifies the
chat draft and pending notebook edit across a project switch, checks that a
follow-up preserves the saved correction, and verifies the saved bytes and
renderer reload. It writes results and screenshots outside the repository. The
synthetic project remains available for inspection. This deterministic probe
does not send a model request; a live chat turn must be checked separately.
