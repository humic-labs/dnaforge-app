# Sequence Git Integration — Architectural Contracts

These contracts were settled after a senior audit (2026-03-21) that identified
20+ fix/revert commits caused by unsettled boundaries. They are frozen.

## Contract 1: Diff Basis = HEAD, falling back to Index

We diff against `HEAD` (last committed version). If the file is staged but never
committed (HEAD doesn't have it), we fall back to the index (`:0:`). This
matches VS Code's behavior — diffs work as soon as a file is tracked. If the
file is fully untracked, there is no diff.

**Enforced in:** `git.ts:gitShowHead()` — tries HEAD, falls back to `:0:`.

## Contract 2: Repo Root = `gitRepoRoot(filePath)`

Repo root is determined by running `git rev-parse --show-toplevel` in the file's
parent directory. This replaces ad-hoc derivations (`filePath.split('/')`
parent, `workspaceStore.folders[0]`).

**Enforced in:** `git.ts:gitRepoRoot()`, called by `useGitDiff` and
`SequenceInfoBar`.

## Contract 3: Persistence = `isDirty` is the sole save guard

`isDirty` is the single flag for both the tab dot indicator and the save guard.
The sequence store derives it: every content-changing operation on the document
model (typing, soft-deletes, substitutions, paste, undo/redo, annotation edits,
accepted analysis results) advances the working revision, and the document is
dirty while that revision differs from the last acknowledged save. No viewer
callback marks the document dirty. The save guard is simply:
`if (!isDirty) return;`

**Enforced in:** `useSequencePersistence.ts:save()`, `store.ts` 

## Contract 4: External Changes = fs.watch Only

`useFileWatcher` (backed by Electron's `fs.watch` in the main process) is the
SOLE mechanism for detecting external file changes. There is NO window.focus
fallback — that was removed because it caused annotation color regressions.

**Enforced in:** `useSequencePersistence.ts` delegates to `useFileWatcher` only.

## Contract 5: Git UI vs Sequence Diff UI = Separate

Two independent systems, no coupling:

1. **SourceControlPanel** — workspace-level git status, staging, commits.
2. **Ruler decorations** — file-level character diff in the sequence viewer.

They share `git.ts` but have no other coupling.
