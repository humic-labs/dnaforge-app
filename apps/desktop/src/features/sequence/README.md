# Sequence Feature

View and edit biological sequences (GenBank, FASTA).

## Architecture

See `ARCHITECTURE.md` for the 5 architectural contracts governing git
integration.

### Key Components

- **SequenceTab** — Screen component. Wires hooks together, renders UI.
- **WorkspaceViewer** — Canvas-based sequence viewer/editor.
- **useSequencePersistence** — Owns save, dirty tracking, external-change
  detection.
- **useGitDiff** — Live character-level diff vs git HEAD.
- **useFileWatcher** — Detects external file changes via fs.watch.
- **useChangeNavigation** — Cmd+Shift+Up/Down to jump between diff changes.

### Data Flow

```
User edits (typing, paste, undo, drawer annotation edit, analysis Apply)
           → sequence store operation → working revision bumps → dirty → tab dot
           → useGitDiff (300ms debounce) → ruler decorations

User saves → useSequencePersistence.save()
           → store.captureForSave() → serialize → write to disk
           → store.acknowledgeSaved(capture) → recomputeNow() → decorations transition
             (newer edits made during the write stay dirty; bounded retry)

External change → fs.watch → useFileWatcher
               → clean: auto-reload (store.setSequence) → refreshHeadContent()
               → dirty: show toast → user chooses
```

### Store

`store.ts` — the one editing model per open sequence , keyed by stable
document ID: saved snapshot, working draft (editor reducer state), the clean
working projection every reader uses, working/saved revisions and the derived
dirty flag, plus scroll positions. The 2D viewer renders the draft through
`sequenceEditorSession(documentId)`. Full flow:
`docs/codebase-guide/14-sequence-editing-model.md`.

## Indexed Genome Data Plane

The indexed genome path is session/tile based. `IndexedGenomeTab` asks Electron
main for `genome.open(source)` and renders the session shell immediately: source
identity, coordinate readiness, track rows, and machine-readable track state.
Background indexing and validation update that same shell through
`genome:sessionUpdated`.

The current renderer still uses a bounded compatibility bridge into
`ParsedPlasmid`/`WebGLMap`, but it may only consume summary tiles, bounded
viewport annotation tiles, lazy feature details, and sequence windows. Do not
reintroduce initial `getFeatures(0, chromosomeLength)` calls or eager
whole-chromosome sequence loads for indexed human-scale sources.

Track states are defined in `shared/indexed-genome.ts` and mapped through
`userStateForGenomeTrackState`. Tests must update that map when adding a state,
so user-facing copy, machine-readable hooks, and diagnostics stay in sync.

### Workflow Coverage Contract

Workflow: open indexed chr11, rapidly zoom from base-level sequence to
chromosome overview and back, then relocate to a CDS.

Representative fixtures / IDs:  generated chr11 indexed fixture, selected
CDS from the live sequence-window probe, and missing-index fixture for
shell/indexing state.

Boundaries crossed: React tab/viewer, WebGL map bridge, platform/preload,
Electron IPC, main session registry, worker-thread genome data source, FASTA
`.fai`, Tabix GFF3, overview cache, and debug snapshot.

Existing mocked tests: `IndexedGenomeViewer.deferred-load.test.tsx` covers
renderer request shape, stale-result suppression, request cancellation, and
state transitions without real Electron/filesystem I/O.

gate for Phase 2 visual evidence.

Success oracle: nucleotide letters and codon letters are visible after
relocation, unknown CDS letters are absent, sequence/annotation requests are
bounded, relocation requests are observed, and the chosen CDS remains centered.

Failure oracles: no relevant console/CDP errors, no stale generation may paint
as current, no `?` codon letters, no missing nucleotide letters after rapid
zooming, no whole-chromosome legacy feature-array request, and no
screenshot-only visual gate.
