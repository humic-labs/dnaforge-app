# Junction Workbench Capability Decision Contract

This is the source-of-truth map for deciding whether a workbench action is
allowed. A renderer is allowed to ask for a decision. It is not allowed to
invent one.

## Verdict

The workbench already has the right core architecture:

- `AssemblyWorkbenchContract.ts` defines the API-addressable command and
  capability surface.
- `AssemblyWorkbenchSession.ts` derives the serializable editable-field manifest
  consumed by UI, tests, keyboard affordances, and future MCP/API callers.
- `AssemblyWorkbenchReducer.ts` applies or rejects commands with typed errors.
- `HomologyJunctionEditabilityContract.ts` owns RD/PCR/PCR/RD homology
  ownership.
- `provenance/` owns source contribution, muted source context, RD cut glyphs,
  and product ownership projection.
- `AssemblyWorkbenchInteractionCapabilities.ts` maps visible hit targets to
  editable manifest fields for source-register drag gestures.

The system is not permitted to regress to scattered JSX checks such as
`if sourceType === "rd" then disable this button`. Those checks produce exactly
the class of bugs where one visible surface is disabled, another surface still
mutates state, and API callers can create a biologically impossible design.

## Decision Flow

Every mutation must flow through this pipeline:

```text
biology / design state
  -> session projection
     -> editableFields[] + controls[] + findings[]
        -> renderer/keyboard/automation chooses a field or command
           -> editable-field command resolver
              -> reducer command validation
                 -> accepted design state or typed rejection
```

Renderer code can consume:

- `field.disabled`
- `field.constraints`
- `field.range`
- `field.command`
- `control.canEdit...`
- `control.isFixed`

Renderer code must pass manifest fields through to the viewport by junction. It
must not drop all fields behind a coarse card/model flag such as
`model.editable`. Card-level metadata can describe a summary state, but it
cannot decide whether source-register drags, homology handles, PBS handles, or
other controls exist. That decision is field-level.

Renderer code cannot inspect raw biological state to decide editability:

- no `sourceType` checks
- no `rdOverhangs` checks
- no direct `isRestrictionDigestRegion` checks
- no direct `homologyJunctionEditability` calls
- no direct `isGoldenGateJunctionOffsetLocked` calls

Those belong in contract/projection/reducer modules, not presentation modules.

## Contract Layers

### 1. Command Capability Surface

File: `AssemblyWorkbenchContract.ts`

This is the API contract. It defines command names, supported modes, required
versioning, source-context requirements, and typed error codes. This is what an
external caller should negotiate against. A UI feature is not complete unless
the same operation is representable here or explicitly documented as read-only.

### 2. Editable Field Manifest

File: `AssemblyWorkbenchSession.ts`

This is the UI/automation bridge. It converts design state into concrete fields:

- `sourceContributionBoundary`
- `primerPbs`
- `primerTail`
- `homologyArm`
- `goldenGateOverhang`
- `rdResection`

Each field carries anchors, range, disabled status, constraints, and the exact
command payload. UI overlays should render these fields; they should not build
their own biological command meaning.

### 3. Biological Editability Contracts

Current files:

- `HomologyJunctionEditabilityContract.ts`
- Golden Gate fixed-offset helpers in `design/algorithms/draft-assembly.ts`
- RD/source-kind helpers in `design/restriction-digest.ts`

These modules answer biological questions such as:

- Is this homology arm editable?
- Which side owns an RD-adjacent Gibson/NEBuilder overlap?
- Is this Golden Gate overhang fixed by a digest fragment?
- Is this source boundary a physical digest end?

The session uses these contracts to build fields. The reducer uses the same
contracts to reject invalid writes. That double-entry enforcement is
intentional.

### 4. Interaction Capability Adapter

File: `AssemblyWorkbenchInteractionCapabilities.ts`

This maps visible hit targets to manifest fields. It exists because the product
row can contain left-owned bases, right-owned bases, and spacer bases. A product
row being draggable somewhere does not mean every product coordinate is
draggable.

Examples:

- Source row hit on PCR region -> enabled source-boundary field.
- Source row hit on RD region -> disabled field with the RD physical-end
  constraint.
- Product hit on left-owned PCR bases -> left source-boundary field.
- Product hit on spacer bases -> disabled, because spacer text is edited through
  spacer controls.
- Product hit on RD-owned bases -> disabled, because RD physical ends are not
  source-register draggable.

This adapter must stay pure and DOM-free. The viewport may compute which owner
was hit, then ask this adapter for the capability decision.

### 5. Provenance Projection

Files: `provenance/*`

Source contribution, muted source context, source row text, product owner,
restriction digest cut glyphs, and scar annotations must all derive from the
validated provenance projection. Rendering code must not redo interval math.

## Required Tests

Capability changes need all relevant layers:

- Contract/unit: capability adapter and biological editability contract tests.
- Session: editable fields expose enabled/disabled fields with constraints.
- Reducer: invalid commands are rejected even if UI is bypassed.
- Render: visible controls consume fields and cannot expose impossible enabled
  handles.
- L3/acceptance: real product workflow drives the actual UI path and asserts
  data, not only visibility.

Current structural guards:

- `CapabilityDecisionContract.guard.test.ts` prevents raw biological editability
  checks from entering React UI files and keeps source-register targeting behind
  the interaction capability adapter.
- `provenance/rendererBypassGuard.test.ts` prevents renderers from redoing
  source contribution interval math.

## Review Standard

A senior reviewer should be able to trace any enabled UI affordance to:

1. an editable field or command capability,
2. a biological editability/provenance contract,
3. reducer validation that rejects invalid bypass writes,
4. a test at the lowest useful layer, and
5. an acceptance test/probe for the user-visible workflow when the behavior is
   visible or cross-runtime.

If any of those links is missing, do not claim the behavior is fixed.
