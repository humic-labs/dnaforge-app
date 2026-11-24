# AI-only input experiment

This local prototype removes manual scientific authoring from the desktop shell.
Use the existing AI chat to create and change work. The existing output
renderers remain mounted, with their document permissions unchanged.

Output contents are passive in this first version. You can switch tabs, but
within-view zoom, pan, selection and editing are unavailable. This is an initial
experiment, not a replacement for the ordinary desktop interface.

## Run it

Use the Node version in `.nvmrc` and the setup described in the root README.
Start the isolated development app with:

```sh
VITE_AI_ONLY_INPUT=1 node start.mjs
```

The mode requires a local development renderer and the explicit value `1`.
Hosted and production renderers ignore it. Stop the app and restart without the
variable to restore the ordinary interface. The mode does not change project
permissions or saved document formats.

The existing in-app agent route is retained. Configure a provider or a supported
local CLI through the chat connection controls. Existing provider permissions
and approval requests still apply. This experiment adds no new agent transport.

## What changed

The alternate shell mounts the existing canvas and chat lifecycle. It omits the
file tree, import controls, registry controls, terminal and scientific creation
dialogs. The tab strip only switches between already opened views.

Each output's actual portal host gets a presentation boundary with `inert`.
Authoring controls are hidden inside that boundary. The editor and native
working copy stay writable by programmatic operations. Human input outside chat
and tab navigation is rejected, including body-level popup controls. Chat menus
inherit their conversation region from their anchor. Agent approval dialogs
remain available.

The command dispatcher rejects manual authoring commands while leaving the agent
source subject to its existing handlers and permissions. The local native menu
omits import and document mutation entries. Import menu subscriptions and the
normal shell's direct runtime shortcuts are also disabled in this mode.

## Design decision

Two approaches were compared: classify every action in the existing interface,
or build a separate shell around the existing renderers. The separate shell is
the smaller first experiment. The existing interface has direct action handlers,
editors, native menus and portals outside the command dispatcher, so a partial
command policy would leave manual authoring paths available.

Both designs require separating human interaction from document authority.
Setting documents globally read-only would also prevent agent operations. This
prototype changes presentation only.

The strict output boundary deliberately gives up inspection interactions. A next
iteration should restore specific view-only interactions after distinguishing
them from scientific mutations. A generic rule based on button text cannot make
that distinction reliably.

## Verify the browser prototype

Start the test-mode renderer in one terminal:

```sh
VITE_AI_ONLY_INPUT=1 pnpm --dir apps/desktop exec vite \
  --config vite.renderer.config.ts --mode test \
  --host 127.0.0.1 --port 14636 --strictPort
```

With Google Chrome installed, run:

```sh
node apps/desktop/scripts/probe-ai-only-input.mjs \
  http://127.0.0.1:14636 /tmp/dnaforge-ai-input-probe
```

The probe creates an in-memory synthetic project through the browser platform,
then calls the existing notebook agent tool to create, inspect, edit and save a
notebook. It checks the rendered output, attempts manual typing and drops,
checks chat input and tab navigation, and writes `result.json` and a screenshot.
It refuses to run against a native renderer.

This verifies the real notebook tool and editor inside the browser presentation.
The browser platform mocks persistence and native transport. It does not prove a
live model turn, native IPC, filesystem persistence or complete output parity.

Focused unit and component checks:

```sh
pnpm --dir apps/desktop test -- \
  src/lib/ai-only-input.test.ts \
  src/components/AiOnlyWorkbench.test.tsx \
  src/components/AiOnlyWorkbench.agent.test.tsx \
  src/commands/CommandScopeProvider.ai-only.test.tsx \
  src/commands/CommandScopeProvider.test.tsx \
  src/components/PortalMenu.test.tsx \
  src/main/__tests__/menu.ai-only.test.ts \
  src/main/__tests__/menu.test.ts \
  src/main/__tests__/menu-import.test.ts
```
