# @waypoint/strider-evals

Descriptor-driven deterministic evaluations validate action results, state coherence, audit entries and provenance. The package uses mock model inputs and makes no live model calls.

## Four descriptor shapes

| Kind              | Asserts                                                                                                                                                                        | Layer                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| `action`          | Calling a `defineAction`-wrapped handler with a fixed input produces the expected `ActionResult` envelope, including schema validation, scope enforcement, and error semantics | Wrapper — targets `@waypoint/agent-tools` shape directly |
| `state-coherence` | Stale `expectedRevisions` → `STALE_STATE` with no mutation; success bumps revision by exactly 1 (D2)                                                                           | **Bridge layer (D2)** — exercised today via the F1 stub  |
| `audit`           | Every dispatched action writes an audit v2 entry with before/after state, session id, scope, affected entities (D3)                                                            | **Bridge layer (D3)** — exercised today via the F1 stub  |
| `provenance`      | Sequence-producing actions attach a `ProvenanceRecord` with the correct derivation chain (D4 / D12)                                                                            | **Bridge layer (D4)** — exercised today via the F1 stub  |

All four are Zod-validated. Add a new shape by extending the discriminated union
in `src/descriptor/index.ts` and wiring an executor in `src/runner/`.


## Writing an eval

```ts
// my-feature.eval.ts
import {
  InMemoryAuditSink,
  InMemoryProvenanceSink,
  InMemoryStore,
  registerEvalDescriptor,
  type ActionEvalDescriptor,
  type ActionHandle,
  type EvalEnvironment,
} from '@waypoint/strider-evals';
import { myAction } from './my-action.ts'; // your defineAction-wrapped handler

function buildEnvironment(): EvalEnvironment {
  const registry = new Map<string, ActionHandle<unknown, unknown>>();
  registry.set('sequence.rename', myAction as ActionHandle<unknown, unknown>);
  return {
    store: new InMemoryStore(),
    audit: new InMemoryAuditSink(),
    provenance: new InMemoryProvenanceSink(),
    resolveAction: (name) => registry.get(name),
  };
}

const descriptor: ActionEvalDescriptor = {
  id: 'sequence-rename-success',
  kind: 'action',
  description: 'sequence.rename returns ok=true with the renamed sequence.',
  mode: 'mock-llm',
  tags: ['B1'],
  actionName: 'sequence.rename',
  runtime: 'renderer',
  effects: ['mutating'],
  actionClass: 'modify',
  input: { sequenceId: 'plasmid-001', newName: 'pUC19-fixed' },
  assertions: {
    success: {
      resultEquals: {
        sequenceId: 'plasmid-001',
        name: 'pUC19-fixed',
        revision: 1,
      },
    },
    // Alternative branch for the failure case:
    //   failure: { code: 'BAD_INPUT', messageContains: 'non-empty', retriable: false },
  },
};

registerEvalDescriptor(descriptor, () => buildEnvironment());
```

Filename ends in `.eval.ts` — `vitest.config.ts` picks both `*.test.ts` and
`*.eval.ts` so descriptors self-register without separate boilerplate.

## Running

```bash
cd packages/core/strider-evals
pnpm test                  # full suite
pnpm test:watch            # rerun on save
pnpm typecheck             # tsc --noEmit
```

CI Light's Nx affected pipeline picks this up automatically — the project
exposes `test` and `typecheck` targets in `project.json`.

## Contract with `@waypoint/agent-tools` (B1)

`src/define-action-stub/` ships a reference shim. **The dispatch ENVELOPE
matches B1 exactly; the DESCRIPTOR shape does NOT.** Two layers, one honest
about each:

**Dispatch envelope (matches B1, runtime-pinned):**

- returns `Promise<ActionResult<Output>>` =
  `{ok: true, result} | {ok: false, error: {code, message, retriable, details?}}`
- handler errors map to the same 5-code enum (`BAD_INPUT`, `STALE_STATE`,
  `SCOPE_DENIED`, `EXECUTION_FAILED`, `NOT_IMPLEMENTED`) — pinned by a
  cross-package sync test that imports `ALL_ACTION_ERROR_CODES` from
  `@waypoint/agent-tools`
- `actionName` validated via `@waypoint/agent-tools`'s `isValidActionName` —
  pinned by a parity test

**Descriptor shape (intentionally different):**

- Stub:
  `defineAction({name, runtime, effects, actionClass, parseInput, reads, writes, handler})`
- B1:
  `defineAction({name, description, runtime, effects, inputSchema, outputSchema?, requiredCapabilities?, handler, ...})`
- The stub layers bridge-tier behaviors (audit on every dispatched attempt,
  optimistic concurrency via `expectedRevisions`) that B1 deliberately excludes
  — D2/D3/D4 own those in the real bridge
- A B1 descriptor is NOT swappable for a stub descriptor — example evals that
  use this stub need a stub-shaped action definition

**What this means for porting:**

- An `ActionEvalDescriptor` is portable across the stub and B1 because it
  references only the envelope shape + action name + assertions
- safety-coverage includes registered wrapper evals that adapt real
  `@waypoint/agent-tools.defineAction()` actions into the runner, covering input
  schema failures, output schema failures, `SCOPE_DENIED`, pass-through
  `STALE_STATE`, plain `EXECUTION_FAILED`, and `NOT_IMPLEMENTED`
- When you re-point an eval at `@waypoint/agent-tools` (post D2/D3/D4), the
  descriptor stays; only the action definition + environment factory swap
- Stub-only behaviors (audit-on-parseInput-failure, optimistic concurrency at
  dispatch) are documented gaps: descriptors that rely on them are valid against
  the stub today; the bridge will or won't reproduce that behavior depending on
  D2/D3 design choices

## What this is NOT

- Not a UI test. The renderer never mounts. For chat-rendering / tool-result-DOM
  coverage, see the existing browser eval at `e2e/desktop/ai-eval.spec.ts` (F3
  will extend that to drive real Electron + real action registry).
- Not a real-LLM eval. Tool-call replay is a fixed transcript. F3 / F5 do real
  model calls.
- Not a screenshot gate. Behavioral assertions only (see
  `feedback_screenshots_never_the_gate.md` / .
