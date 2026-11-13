// @vitest-environment node

import { describe, it, expect, beforeEach } from 'vitest';
import type { AnnotatedSequence, Annotation } from '@waypoint/sequence-utils';
import { sequenceEditorSession, useSequenceStore } from './store';
import { freezeWorkspaceEditorWrites } from '../../services/workspace-editor-mutation-state';

const DOC = 'sequence-document-model';

describe('saved material after undo', () => {
  beforeEach(resetStore);

  it('returns to the saved material without a dirty draft or a revision rewind', () => {
    loadExample();
    const saved = useSequenceStore.getState().captureForSave(DOC)!;
    type('TT', 6);
    const editedRevision = useSequenceStore.getState().getVersion(DOC);
    useSequenceStore.getState().dispatchEdit(DOC, { type: 'UNDO' });
    const state = useSequenceStore.getState();
    const undone = state.captureForSave(DOC)!;
    expect(undone.sequence).toEqual(saved.sequence);
    expect(undone.pendingPrimerBindings).toEqual(saved.pendingPrimerBindings);
    expect(undone.insertedRanges).toEqual([]);
    expect(undone.deletedRanges).toEqual([]);
    expect(undone.substitutedRanges).toEqual([]);
    expect(undone.draftBaseline).toEqual(saved.draftBaseline);
    expect(undone.draftLineageId).toBe(saved.draftLineageId);
    expect(undone.revision).toBeGreaterThan(editedRevision);
    expect(state.savedVersions[DOC]).toBe(saved.revision);
    expect(state.isDirty(DOC)).toBe(false);
  });

  it('tracks annotation-only undo and redo against the saved feature material', () => {
    loadExample();
    const saved = useSequenceStore.getState().captureForSave(DOC)!;
    useSequenceStore
      .getState()
      .updateAnnotation(DOC, 0, { ...ann('renamed', 5, 8), color: '#123456' });
    expect(working()?.sequence).toBe(saved.sequence.sequence);
    expect(useSequenceStore.getState().isDirty(DOC)).toBe(true);
    useSequenceStore.getState().dispatchEdit(DOC, { type: 'UNDO' });
    expect(working()).toEqual(saved.sequence);
    expect(useSequenceStore.getState().isDirty(DOC)).toBe(false);
    useSequenceStore.getState().dispatchEdit(DOC, { type: 'REDO' });
    expect(working()?.annotations[0]?.name).toBe('renamed');
    expect(useSequenceStore.getState().isDirty(DOC)).toBe(true);
  });

  it('keeps an identical-base rich paste dirty while its primer binding is pending', () => {
    useSequenceStore.getState().setSequence(DOC, makeSequence());
    const saved = useSequenceStore.getState().captureForSave(DOC)!;
    useSequenceStore.getState().dispatchEdit(DOC, { type: 'SELECT_ALL' });
    useSequenceStore.getState().dispatchEdit(DOC, {
      type: 'INSERT_FRAGMENT',
      fragment: {
        sequence: saved.sequence.sequence,
        annotations: [],
        primerBindings: [{ primerId: 'p1', start: 0, end: 4, strand: 1 }],
      },
    });
    expect(working()).toEqual(saved.sequence);
    expect(useSequenceStore.getState().captureForSave(DOC)?.pendingPrimerBindings).toHaveLength(1);
    expect(useSequenceStore.getState().isDirty(DOC)).toBe(true);
  });

  it('becomes dirty again when an undone in-flight capture actually reaches disk', () => {
    loadExample();
    type('TT', 6);
    const capture = useSequenceStore.getState().captureForSave(DOC)!;
    useSequenceStore.getState().dispatchEdit(DOC, { type: 'UNDO' });
    expect(useSequenceStore.getState().isDirty(DOC)).toBe(false);
    expect(useSequenceStore.getState().acknowledgeSaved(DOC, capture).settled).toBe(false);
    const state = useSequenceStore.getState();
    expect(state.savedSequences[DOC]).toEqual(capture.sequence);
    expect(working()?.sequence).toBe('AAAACCCCGGGG');
    expect(state.getVersion(DOC)).toBeGreaterThan(capture.revision);
    expect(state.isDirty(DOC)).toBe(true);
  });
});

function makeSequence(overrides: Partial<AnnotatedSequence> = {}): AnnotatedSequence {
  return {
    id: DOC,
    name: 'fixture',
    length: 4,
    sequence: 'ACGT',
    annotations: [],
    metadata: {},
    circular: false,
    ...overrides,
  };
}

function ann(
  name: string,
  start: number,
  end: number,
  extra: Partial<Annotation> = {}
): Annotation {
  return { name, type: 'misc_feature', start, end, direction: 1, ...extra };
}

function loadExample(): void {
  useSequenceStore
    .getState()
    .setSequence(
      DOC,
      makeSequence({ sequence: 'AAAACCCCGGGG', length: 12, annotations: [ann('cc', 5, 8)] })
    );
}

function type(text: string, position?: number): void {
  const store = useSequenceStore.getState();
  if (position !== undefined) store.dispatchEdit(DOC, { type: 'SET_CURSOR', position });
  store.dispatchEdit(DOC, { type: 'INSERT', text });
}

function working() {
  return useSequenceStore.getState().sequences[DOC];
}

function resetStore() {
  useSequenceStore.setState(
    {
      ...useSequenceStore.getState(),
      sequences: {},
      savedSequences: {},
      drafts: {},
      draftLineages: {},
      loadingDocumentIds: new Set(),
      scrollPositions: {},
      sequenceVersions: {},
      savedVersions: {},
      dirtyPaths: {},
      revision: 0,
    },
    true
  );
}

describe('document edits during a native workspace mutation', () => {
  beforeEach(resetStore);

  it.each(['typing', 'annotation', 'discard'] as const)(
    'refuses %s on the affected document even without a mounted editor',
    (action) => {
      loadExample();
      if (action === 'discard') type('A', 0);
      const before = useSequenceStore.getState().captureForSave(DOC);
      const release = freezeWorkspaceEditorWrites({
        workspaceRoot: '/managed/command-target',
        affectedEntityIds: [DOC],
      });
      const edit = () => {
        const store = useSequenceStore.getState();
        if (action === 'typing') store.dispatchEdit(DOC, { type: 'INSERT', text: 'A' });
        else if (action === 'annotation') store.mergeAnnotations(DOC, [ann('incoming', 1, 2)]);
        else store.discardEdits(DOC);
      };
      try {
        expect(edit).toThrow(/workspace update/);
        expect(useSequenceStore.getState().captureForSave(DOC)).toEqual(before);
      } finally {
        release();
      }
      expect(edit).not.toThrow();
      expect(useSequenceStore.getState().captureForSave(DOC)).not.toEqual(before);
    }
  );

  it('allows the native refresh to replace the clean snapshot while edits stay frozen', () => {
    loadExample();
    const release = freezeWorkspaceEditorWrites({
      workspaceRoot: '/managed/command-target',
      affectedEntityIds: [DOC],
    });
    try {
      const incoming = makeSequence({ annotations: [ann('saved-by-owner', 1, 2)] });
      useSequenceStore.getState().setSequence(DOC, incoming);
      expect(working()).toEqual(incoming);
      expect(useSequenceStore.getState().isDirty(DOC)).toBe(false);
      expect(() => type('A')).toThrow(/workspace update/);
    } finally {
      release();
    }
  });
});

describe('sequence version tracking', () => {
  beforeEach(() => {
    resetStore();
  });

  it('getVersion returns 0 for unknown documents', () => {
    expect(useSequenceStore.getState().getVersion('sequence-document-unknown')).toBe(0);
  });

  it('rejects a filesystem path at the cache boundary', () => {
    expect(() =>
      useSequenceStore.getState().setSequence('/project/source.gb', makeSequence())
    ).toThrow('stable document ID');
  });

  it('setSequence increases version by 1 (centralized — per-store-invariants)', () => {
    const store = useSequenceStore.getState();
    store.setSequence('sequence-document-file', makeSequence());
    expect(useSequenceStore.getState().getVersion('sequence-document-file')).toBe(1);
    useSequenceStore.getState().setSequence('sequence-document-file', makeSequence());
    expect(useSequenceStore.getState().getVersion('sequence-document-file')).toBe(2);
  });

  it('versions are independent per document', () => {
    const store = useSequenceStore.getState();
    store.setSequence('sequence-document-a', makeSequence());
    useSequenceStore.getState().setSequence('sequence-document-a', makeSequence());
    useSequenceStore.getState().setSequence('sequence-document-b', makeSequence());
    expect(useSequenceStore.getState().getVersion('sequence-document-a')).toBe(2);
    expect(useSequenceStore.getState().getVersion('sequence-document-b')).toBe(1);
  });

  it('clearAll resets versions', () => {
    const store = useSequenceStore.getState();
    store.setSequence('sequence-document-file', makeSequence());
    useSequenceStore.getState().clearAll();
    expect(useSequenceStore.getState().getVersion('sequence-document-file')).toBe(0);
  });
});

describe('sequence store .revision (per-store-invariants)', () => {
  beforeEach(() => {
    resetStore();
  });

  it('initial revision is 0', () => {
    expect(useSequenceStore.getState().revision).toBe(0);
  });

  it('setSequence bumps revision by exactly 1', () => {
    const before = useSequenceStore.getState().revision;
    useSequenceStore.getState().setSequence('sequence-document-a', makeSequence());
    expect(useSequenceStore.getState().revision).toBe(before + 1);
  });

  it('setSequence ALSO bumps the per-document version (centralized — per-store-invariants)', () => {
    useSequenceStore.getState().setSequence('sequence-document-a', makeSequence());
    expect(useSequenceStore.getState().getVersion('sequence-document-a')).toBe(1);

    useSequenceStore
      .getState()
      .setSequence('sequence-document-a', makeSequence({ annotations: [] }));
    expect(useSequenceStore.getState().getVersion('sequence-document-a')).toBe(2);
  });

  it('setSequence on a different document does not bump the other document version', () => {
    useSequenceStore.getState().setSequence('sequence-document-a', makeSequence());
    useSequenceStore.getState().setSequence('sequence-document-b', makeSequence());
    expect(useSequenceStore.getState().getVersion('sequence-document-a')).toBe(1);
    expect(useSequenceStore.getState().getVersion('sequence-document-b')).toBe(1);

    expect(useSequenceStore.getState().revision).toBe(2);
  });

  it('setLoading bumps revision; no-op transitions do not', () => {
    const start = useSequenceStore.getState().revision;
    useSequenceStore.getState().setLoading('sequence-document-a', true);
    expect(useSequenceStore.getState().revision).toBe(start + 1);

    useSequenceStore.getState().setLoading('sequence-document-a', true);
    expect(useSequenceStore.getState().revision).toBe(start + 1);
    useSequenceStore.getState().setLoading('sequence-document-a', false);
    expect(useSequenceStore.getState().revision).toBe(start + 2);
  });

  it('setScrollPosition bumps revision; same-value writes do not', () => {
    const start = useSequenceStore.getState().revision;
    useSequenceStore.getState().setScrollPosition('sequence-document-a', 42);
    expect(useSequenceStore.getState().revision).toBe(start + 1);
    useSequenceStore.getState().setScrollPosition('sequence-document-a', 42);
    expect(useSequenceStore.getState().revision).toBe(start + 1);
    useSequenceStore.getState().setScrollPosition('sequence-document-a', 7);
    expect(useSequenceStore.getState().revision).toBe(start + 2);
  });

  it('clearScrollPosition bumps revision only when a position exists', () => {
    useSequenceStore.getState().setScrollPosition('sequence-document-a', 42);
    const before = useSequenceStore.getState().revision;
    useSequenceStore.getState().clearScrollPosition('sequence-document-a');
    expect(useSequenceStore.getState().revision).toBe(before + 1);

    const after = useSequenceStore.getState().revision;
    useSequenceStore.getState().clearScrollPosition('sequence-document-a');
    expect(useSequenceStore.getState().revision).toBe(after);
  });

  it('clearSequence bumps revision only when the entry exists', () => {
    useSequenceStore.getState().setSequence('sequence-document-a', makeSequence());
    const before = useSequenceStore.getState().revision;
    useSequenceStore.getState().clearSequence('sequence-document-a');
    expect(useSequenceStore.getState().revision).toBe(before + 1);

    const after = useSequenceStore.getState().revision;
    useSequenceStore.getState().clearSequence('sequence-document-a');
    expect(useSequenceStore.getState().revision).toBe(after);
  });

  it('a content edit bumps revision once; a cursor move bumps it without dirtying', () => {
    useSequenceStore.getState().setSequence(DOC, makeSequence());
    const before = useSequenceStore.getState().revision;
    useSequenceStore.getState().dispatchEdit(DOC, { type: 'INSERT', text: 'A' });
    expect(useSequenceStore.getState().revision).toBe(before + 1);
    expect(useSequenceStore.getState().isDirty(DOC)).toBe(true);
    const version = useSequenceStore.getState().getVersion(DOC);
    useSequenceStore.getState().dispatchEdit(DOC, { type: 'SET_CURSOR', position: 2 });
    expect(useSequenceStore.getState().getVersion(DOC)).toBe(version);
  });

  it('markClean bumps revision only when the document was dirty', () => {
    useSequenceStore.getState().setSequence(DOC, makeSequence());
    type('A', 0);
    const before = useSequenceStore.getState().revision;
    useSequenceStore.getState().markClean(DOC);
    expect(useSequenceStore.getState().revision).toBe(before + 1);

    const after = useSequenceStore.getState().revision;
    useSequenceStore.getState().markClean(DOC);
    expect(useSequenceStore.getState().revision).toBe(after);
  });

  it('clearAll bumps revision', () => {
    useSequenceStore.getState().setSequence('sequence-document-a', makeSequence());
    const before = useSequenceStore.getState().revision;
    useSequenceStore.getState().clearAll();
    expect(useSequenceStore.getState().revision).toBe(before + 1);
    expect(useSequenceStore.getState().getVersion('sequence-document-a')).toBe(0);
  });
});

describe('sequence document model ', () => {
  beforeEach(() => {
    resetStore();
  });

  it('loading makes the content both saved and working, with an empty clean draft', () => {
    loadExample();
    const state = useSequenceStore.getState();
    expect(state.sequences[DOC]).toBe(state.savedSequences[DOC]);
    expect(state.drafts[DOC]?.sequence).toBe('AAAACCCCGGGG');
    expect(state.drafts[DOC]?.annotations).toEqual([ann('cc', 5, 8)]);
    expect(state.isDirty(DOC)).toBe(false);
    expect(state.getVersion(DOC)).toBe(state.savedVersions[DOC]);
  });

  it('inserting inside an annotation stretches it in the working document (AAAA [CCTTCC] GGGG)', () => {
    loadExample();
    type('TT', 6);
    const doc = working();
    expect(doc?.sequence).toBe('AAAACCTTCCGGGG');
    expect(doc?.length).toBe(14);
    expect(doc?.annotations).toEqual([ann('cc', 5, 10)]);
    expect(useSequenceStore.getState().isDirty(DOC)).toBe(true);
    expect(useSequenceStore.getState().getVersion(DOC)).toBe(2);

    expect(useSequenceStore.getState().savedSequences[DOC]?.sequence).toBe('AAAACCCCGGGG');
  });

  it('inserting before an annotation moves it; inserting after leaves it alone', () => {
    loadExample();
    type('TT', 0);
    expect(working()?.annotations).toEqual([ann('cc', 7, 10)]);
    type('GG', 14);
    expect(working()?.sequence).toBe('TTAAAACCCCGGGGGG');
    expect(working()?.annotations).toEqual([ann('cc', 7, 10)]);
  });

  it('renaming after an insertion keeps both edits in one revision', () => {
    loadExample();
    type('TT', 6);
    useSequenceStore.getState().updateAnnotation(DOC, 0, {
      name: 'renamed',
      type: 'misc_feature',
      direction: 1,
      color: '#123456',
      start: 5,
      end: 10,
    });
    const doc = working();
    expect(doc?.sequence).toBe('AAAACCTTCCGGGG');
    expect(doc?.annotations).toEqual([
      { name: 'renamed', type: 'misc_feature', direction: 1, color: '#123456', start: 5, end: 10 },
    ]);
    expect(useSequenceStore.getState().getVersion(DOC)).toBe(3);

    const draft = useSequenceStore.getState().drafts[DOC];
    expect(draft?.annotations[0]?.name).toBe('renamed');
    expect(draft?.insertedRanges).toEqual([{ start: 6, end: 8 }]);
  });

  it('a range change drops cached protein qualifiers; a rename alone keeps them', () => {
    useSequenceStore.getState().setSequence(
      DOC,
      makeSequence({
        sequence: 'ATGAAATAG',
        length: 9,
        annotations: [
          ann('orf', 1, 9, {
            type: 'CDS',
            qualifiers: {
              translation: ['MK'],
              codon_start: ['1'],
              transl_table: ['11'],
              gene: ['x'],
            },
          }),
        ],
      })
    );
    const base = { type: 'CDS', direction: 1 as const, color: '#000000' };
    useSequenceStore
      .getState()
      .updateAnnotation(DOC, 0, { ...base, name: 'orf2', start: 1, end: 9 });
    expect(working()?.annotations[0]?.qualifiers).toEqual({
      translation: ['MK'],
      codon_start: ['1'],
      transl_table: ['11'],
      gene: ['x'],
    });
    useSequenceStore
      .getState()
      .updateAnnotation(DOC, 0, { ...base, name: 'orf2', start: 1, end: 6 });
    expect(working()?.annotations[0]?.qualifiers).toEqual({ gene: ['x'] });
  });

  it('undo and redo restore exact bases, boundaries and markup', () => {
    loadExample();
    type('TT', 6);
    useSequenceStore.getState().dispatchEdit(DOC, { type: 'UNDO' });
    expect(working()?.sequence).toBe('AAAACCCCGGGG');
    expect(working()?.annotations).toEqual([ann('cc', 5, 8)]);
    expect(useSequenceStore.getState().drafts[DOC]?.insertedRanges).toEqual([]);
    expect(useSequenceStore.getState().isDirty(DOC)).toBe(false);
    useSequenceStore.getState().dispatchEdit(DOC, { type: 'REDO' });
    expect(working()?.sequence).toBe('AAAACCTTCCGGGG');
    expect(working()?.annotations).toEqual([ann('cc', 5, 10)]);
    expect(useSequenceStore.getState().drafts[DOC]?.insertedRanges).toEqual([{ start: 6, end: 8 }]);
    expect(useSequenceStore.getState().isDirty(DOC)).toBe(true);
  });

  it('soft deletions stay visible in the draft but are gone from the working document', () => {
    loadExample();

    useSequenceStore.getState().dispatchEdit(DOC, { type: 'SET_CURSOR', position: 8 });
    useSequenceStore.getState().dispatchEdit(DOC, { type: 'DELETE_BEFORE' });
    useSequenceStore.getState().dispatchEdit(DOC, { type: 'DELETE_BEFORE' });
    const draft = useSequenceStore.getState().drafts[DOC];
    expect(draft?.sequence).toBe('AAAACCCCGGGG');
    expect(draft?.deletedRanges).toEqual([{ start: 6, end: 8 }]);
    expect(working()?.sequence).toBe('AAAACCGGGG');
    expect(working()?.annotations).toEqual([ann('cc', 5, 6)]);
    expect(useSequenceStore.getState().hasPendingSequenceEdits(DOC)).toBe(true);
  });

  it('a substitution changes the base in place and counts as a pending edit', () => {
    loadExample();
    useSequenceStore.getState().dispatchEdit(DOC, { type: 'SET_CURSOR', position: 4 });
    useSequenceStore.getState().dispatchEdit(DOC, { type: 'DELETE_AFTER' });
    useSequenceStore.getState().dispatchEdit(DOC, { type: 'INSERT', text: 'T' });
    expect(working()?.sequence).toBe('AAAATCCCGGGG');
    expect(working()?.annotations).toEqual([ann('cc', 5, 8)]);
    expect(useSequenceStore.getState().drafts[DOC]?.substitutedRanges).toEqual([
      { start: 4, end: 5, original: 'C' },
    ]);
    expect(useSequenceStore.getState().hasPendingSequenceEdits(DOC)).toBe(true);
  });

  it('rich paste carries fragment annotations and staged primer bindings into the working revision', () => {
    loadExample();
    useSequenceStore.getState().dispatchEdit(DOC, { type: 'SET_CURSOR', position: 12 });
    useSequenceStore.getState().dispatchEdit(DOC, {
      type: 'INSERT_FRAGMENT',
      fragment: {
        sequence: 'TTAA',
        annotations: [ann('pasted', 1, 4)],
        primerBindings: [{ primerId: 'p1', start: 0, end: 4, strand: 1 }],
      },
    });
    expect(working()?.sequence).toBe('AAAACCCCGGGGTTAA');
    expect(working()?.annotations).toEqual([ann('cc', 5, 8), ann('pasted', 13, 16)]);
    const capture = useSequenceStore.getState().captureForSave(DOC);
    expect(capture?.pendingPrimerBindings).toEqual([
      { pendingId: expect.any(String), primerId: 'p1', start: 12, end: 16, strand: 1 },
    ]);
  });

  it('save: capture, acknowledge, and the draft is committed with a fresh history', () => {
    loadExample();
    type('TT', 6);
    const capture = useSequenceStore.getState().captureForSave(DOC);
    expect(capture).toMatchObject({ revision: 2, pendingPrimerBindings: [] });
    expect(capture?.sequence.sequence).toBe('AAAACCTTCCGGGG');

    const { settled } = useSequenceStore.getState().acknowledgeSaved(DOC, capture!);
    expect(settled).toBe(true);
    const state = useSequenceStore.getState();
    expect(state.isDirty(DOC)).toBe(false);
    expect(state.savedSequences[DOC]?.sequence).toBe('AAAACCTTCCGGGG');
    expect(state.savedSequences[DOC]?.annotations).toEqual([ann('cc', 5, 10)]);
    expect(state.drafts[DOC]?.insertedRanges).toEqual([]);
    expect(state.drafts[DOC]?.history).toHaveLength(1);
    expect(state.getVersion(DOC)).toBe(2);
  });

  it('edits during save: acknowledging the captured revision keeps the newer edit dirty', () => {
    loadExample();
    type('TT', 6);
    const capture = useSequenceStore.getState().captureForSave(DOC)!;

    type('GG', 0);
    const { settled } = useSequenceStore.getState().acknowledgeSaved(DOC, capture);
    expect(settled).toBe(false);
    const state = useSequenceStore.getState();
    expect(state.isDirty(DOC)).toBe(true);
    expect(state.savedSequences[DOC]?.sequence).toBe('AAAACCTTCCGGGG');
    expect(state.sequences[DOC]?.sequence).toBe('GGAAAACCTTCCGGGG');

    expect(state.drafts[DOC]?.insertedRanges).toEqual([
      { start: 0, end: 2 },
      { start: 8, end: 10 },
    ]);
    const next = state.captureForSave(DOC)!;
    expect(next.revision).toBe(3);
    expect(useSequenceStore.getState().acknowledgeSaved(DOC, next).settled).toBe(true);
    expect(useSequenceStore.getState().isDirty(DOC)).toBe(false);
  });

  it('a failed save acknowledges nothing: edits and markup stay for retry', () => {
    loadExample();
    type('TT', 6);
    const capture = useSequenceStore.getState().captureForSave(DOC)!;

    const state = useSequenceStore.getState();
    expect(state.isDirty(DOC)).toBe(true);
    expect(state.captureForSave(DOC)).toEqual(capture);
  });

  it('discard returns to the saved content and clears dirtiness', () => {
    loadExample();
    type('TT', 6);
    useSequenceStore.getState().updateAnnotation(DOC, 0, {
      name: 'renamed',
      type: 'misc_feature',
      direction: 1,
      color: '#000',
      start: 5,
      end: 10,
    });
    const restored = useSequenceStore.getState().discardEdits(DOC);
    expect(restored?.sequence).toBe('AAAACCCCGGGG');
    const state = useSequenceStore.getState();
    expect(state.sequences[DOC]).toBe(state.savedSequences[DOC]);
    expect(state.drafts[DOC]?.annotations).toEqual([ann('cc', 5, 8)]);
    expect(state.isDirty(DOC)).toBe(false);
    expect(state.hasPendingSequenceEdits(DOC)).toBe(false);
  });

  it('discard after an unsettled save returns to what is on disk, not the edit-session baseline', () => {
    loadExample();
    type('TT', 6);
    const capture = useSequenceStore.getState().captureForSave(DOC)!;
    type('GG', 0);
    useSequenceStore.getState().acknowledgeSaved(DOC, capture);
    const restored = useSequenceStore.getState().discardEdits(DOC);
    expect(restored?.sequence).toBe('AAAACCTTCCGGGG');
    expect(working()?.sequence).toBe('AAAACCTTCCGGGG');
    expect(useSequenceStore.getState().isDirty(DOC)).toBe(false);
  });

  it('annotation-only changes: add sorts by start, delete removes by index, merge appends', () => {
    loadExample();
    useSequenceStore.getState().addAnnotation(DOC, ann('early', 1, 2));
    expect(working()?.annotations).toEqual([ann('early', 1, 2), ann('cc', 5, 8)]);
    useSequenceStore.getState().mergeAnnotations(DOC, [ann('found', 9, 12)]);
    expect(working()?.annotations).toEqual([
      ann('early', 1, 2),
      ann('cc', 5, 8),
      ann('found', 9, 12),
    ]);
    useSequenceStore.getState().deleteAnnotation(DOC, 1);
    expect(working()?.annotations).toEqual([ann('early', 1, 2), ann('found', 9, 12)]);
    expect(working()?.sequence).toBe('AAAACCCCGGGG');
    expect(useSequenceStore.getState().hasPendingSequenceEdits(DOC)).toBe(false);
    expect(useSequenceStore.getState().isDirty(DOC)).toBe(true);

    const version = useSequenceStore.getState().getVersion(DOC);
    useSequenceStore.getState().deleteAnnotation(DOC, 7);
    useSequenceStore.getState().mergeAnnotations(DOC, []);
    expect(useSequenceStore.getState().getVersion(DOC)).toBe(version);
  });

  it('an annotation edit is undoable like any other edit', () => {
    loadExample();
    useSequenceStore.getState().deleteAnnotation(DOC, 0);
    expect(working()?.annotations).toEqual([]);
    useSequenceStore.getState().dispatchEdit(DOC, { type: 'UNDO' });
    expect(working()?.annotations).toEqual([ann('cc', 5, 8)]);
  });

  it('external reload replaces saved and working content and drops pending edits', () => {
    loadExample();
    type('TT', 6);
    useSequenceStore
      .getState()
      .setSequence(
        DOC,
        makeSequence({ sequence: 'GGGG', length: 4, annotations: [ann('g', 1, 4)] })
      );
    const state = useSequenceStore.getState();
    expect(state.sequences[DOC]?.sequence).toBe('GGGG');
    expect(state.drafts[DOC]?.sequence).toBe('GGGG');
    expect(state.drafts[DOC]?.insertedRanges).toEqual([]);
    expect(state.isDirty(DOC)).toBe(false);
  });

  it('empty content is a valid working state', () => {
    useSequenceStore.getState().setSequence(DOC, makeSequence({ sequence: '', length: 0 }));
    expect(working()?.sequence).toBe('');
    type('ATG', 0);
    expect(working()?.sequence).toBe('ATG');
    expect(working()?.length).toBe(3);
    const capture = useSequenceStore.getState().captureForSave(DOC)!;
    useSequenceStore.getState().acknowledgeSaved(DOC, capture);
    expect(useSequenceStore.getState().savedSequences[DOC]?.sequence).toBe('ATG');
    useSequenceStore.getState().dispatchEdit(DOC, { type: 'SELECT_ALL' });
    useSequenceStore.getState().dispatchEdit(DOC, { type: 'DELETE_SELECTION' });
    expect(working()?.sequence).toBe('');
    expect(useSequenceStore.getState().isDirty(DOC)).toBe(true);
  });

  it('metadata patched by another owner survives a settled save and never dirties', () => {
    loadExample();
    type('TT', 6);
    const capture = useSequenceStore.getState().captureForSave(DOC)!;
    useSequenceStore.getState().patchSavedMetadata(DOC, { circular: true });
    expect(working()?.circular).toBe(true);
    expect(useSequenceStore.getState().getVersion(DOC)).toBe(capture.revision);
    useSequenceStore.getState().acknowledgeSaved(DOC, capture);
    const state = useSequenceStore.getState();
    expect(state.sequences[DOC]?.circular).toBe(true);
    expect(state.savedSequences[DOC]?.circular).toBe(true);
    expect(state.savedSequences[DOC]?.sequence).toBe('AAAACCTTCCGGGG');
    expect(state.isDirty(DOC)).toBe(false);
  });

  it('lifecycle actions are owned by the model and rejected as edits', () => {
    loadExample();
    for (const action of ['RESET', 'COMMIT', 'DISCARD', 'MARK_SAVED'] as const) {
      expect(() =>
        useSequenceStore
          .getState()
          .dispatchEdit(DOC, { type: action, sequence: '', annotations: [] } as never)
      ).toThrow(/owned by the document model/);
    }
  });

  it('edits to an unloaded document are ignored and clearing removes every projection', () => {
    useSequenceStore.getState().dispatchEdit(DOC, { type: 'INSERT', text: 'A' });
    expect(useSequenceStore.getState().captureForSave(DOC)).toBeNull();
    loadExample();
    type('T', 0);
    useSequenceStore.getState().clearSequence(DOC);
    const state = useSequenceStore.getState();
    expect(state.sequences[DOC]).toBeUndefined();
    expect(state.drafts[DOC]).toBeUndefined();
    expect(state.savedSequences[DOC]).toBeUndefined();
    expect(state.dirtyPaths[DOC]).toBeUndefined();
    expect(state.getVersion(DOC)).toBe(0);
  });

  it('the editor session exposes the draft and notifies only on draft changes', () => {
    loadExample();
    const session = sequenceEditorSession(DOC);
    let notified = 0;
    const unsubscribe = session.subscribe(() => {
      notified += 1;
    });
    expect(session.getState().sequence).toBe('AAAACCCCGGGG');
    session.dispatch({ type: 'SET_CURSOR', position: 6 });
    session.dispatch({ type: 'INSERT', text: 'TT' });
    expect(notified).toBe(2);
    expect(session.getState().sequence).toBe('AAAACCTTCCGGGG');
    useSequenceStore.getState().setScrollPosition(DOC, 3);
    expect(notified).toBe(2);
    unsubscribe();
    session.dispatch({ type: 'INSERT', text: 'A' });
    expect(notified).toBe(2);
    expect(working()?.sequence).toBe('AAAACCTTACCGGGG');
  });
});

describe('sequence document model — working ↔ draft mapping while deletions are pending', () => {
  beforeEach(() => {
    resetStore();
  });

  function deleteFirstTwoBases(): void {
    useSequenceStore.getState().dispatchEdit(DOC, { type: 'SET_CURSOR', position: 2 });
    useSequenceStore.getState().dispatchEdit(DOC, { type: 'DELETE_BEFORE' });
    useSequenceStore.getState().dispatchEdit(DOC, { type: 'DELETE_BEFORE' });
  }

  it('renaming through the drawer keeps the working boundaries; the deletion is not applied twice', () => {
    loadExample();
    deleteFirstTwoBases();

    expect(working()?.sequence).toBe('AACCCCGGGG');
    expect(working()?.annotations).toEqual([ann('cc', 3, 6)]);

    useSequenceStore.getState().updateAnnotation(DOC, 0, {
      name: 'renamed',
      type: 'misc_feature',
      direction: 1,
      color: '#000000',
      start: 3,
      end: 6,
    });

    expect(useSequenceStore.getState().drafts[DOC]?.annotations[0]).toMatchObject({
      name: 'renamed',
      start: 5,
      end: 8,
    });

    expect(working()?.annotations).toEqual([
      { name: 'renamed', type: 'misc_feature', direction: 1, color: '#000000', start: 3, end: 6 },
    ]);
    expect(useSequenceStore.getState().captureForSave(DOC)?.sequence.annotations[0]).toMatchObject({
      start: 3,
      end: 6,
    });
  });

  it('a feature erased by a pending deletion does not shift drawer indexes', () => {
    useSequenceStore.getState().setSequence(
      DOC,
      makeSequence({
        sequence: 'AAAACCCCGGGG',
        length: 12,
        annotations: [ann('x', 1, 2), ann('cc', 5, 8)],
      })
    );
    deleteFirstTwoBases();

    expect(working()?.annotations).toEqual([ann('cc', 3, 6)]);

    useSequenceStore.getState().updateAnnotation(DOC, 0, {
      name: 'cc-renamed',
      type: 'misc_feature',
      direction: 1,
      color: '#000000',
      start: 3,
      end: 6,
    });
    expect(working()?.annotations).toEqual([
      {
        name: 'cc-renamed',
        type: 'misc_feature',
        direction: 1,
        color: '#000000',
        start: 3,
        end: 6,
      },
    ]);

    expect(useSequenceStore.getState().drafts[DOC]?.annotations[0]).toEqual(ann('x', 1, 2));

    useSequenceStore.getState().deleteAnnotation(DOC, 0);
    expect(working()?.annotations).toEqual([]);
    const capture = useSequenceStore.getState().captureForSave(DOC)!;
    expect(capture.sequence.annotations).toEqual([]);
    useSequenceStore.getState().acknowledgeSaved(DOC, capture);
    expect(useSequenceStore.getState().drafts[DOC]?.annotations).toEqual([]);
  });

  it('adding an annotation from working coordinates lands on the same bases in the draft', () => {
    loadExample();
    deleteFirstTwoBases();

    useSequenceStore.getState().addAnnotation(DOC, ann('gg', 7, 10));
    expect(useSequenceStore.getState().drafts[DOC]?.annotations).toEqual([
      ann('cc', 5, 8),
      ann('gg', 9, 12),
    ]);
    expect(working()?.annotations).toEqual([ann('cc', 3, 6), ann('gg', 7, 10)]);

    useSequenceStore.getState().addAnnotation(DOC, ann('span', 1, 4));
    expect(useSequenceStore.getState().drafts[DOC]?.annotations[0]).toEqual(ann('span', 3, 6));
    expect(working()?.annotations[0]).toEqual(ann('span', 1, 4));
  });

  it('out-of-range drawer indexes and unknown documents change nothing', () => {
    loadExample();
    const before = useSequenceStore.getState();
    const version = before.getVersion(DOC);
    const history = before.drafts[DOC]!.history.length;
    const patch = {
      name: 'x',
      type: 'misc_feature',
      direction: 1 as const,
      color: '#000',
      start: 1,
      end: 2,
    };
    useSequenceStore.getState().updateAnnotation(DOC, 7, patch);
    useSequenceStore.getState().updateAnnotation(DOC, -1, patch);
    useSequenceStore.getState().addAnnotation('sequence-document-unknown', ann('u', 1, 2));
    const after = useSequenceStore.getState();
    expect(after.getVersion(DOC)).toBe(version);
    expect(after.isDirty(DOC)).toBe(false);
    expect(after.drafts[DOC]!.history).toHaveLength(history);
    expect(after.drafts['sequence-document-unknown']).toBeUndefined();
  });
});

describe('managed annotation identity in renderer edits', () => {
  beforeEach(resetStore);

  it('keeps the reserved ID when an edit explicitly replaces other qualifiers', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const original: Annotation = {
      ...ann('managed', 2, 4),
      qualifiers: { dnaforge_ann_id: [id], translation: ['M'] },
    };
    useSequenceStore.getState().setSequence(DOC, makeSequence({ annotations: [original] }));
    useSequenceStore.getState().updateAnnotation(DOC, 0, {
      name: 'renamed',
      type: original.type,
      direction: original.direction,
      color: original.color ?? '#000000',
      start: original.start,
      end: original.end,
      qualifiers: { translation: ['M'] },
    });
    expect(
      useSequenceStore.getState().captureForSave(DOC)?.sequence.annotations?.[0].qualifiers
    ).toMatchObject({ dnaforge_ann_id: [id], translation: ['M'] });
    expect(() =>
      useSequenceStore.getState().updateAnnotation(DOC, 0, {
        name: 'renamed again',
        type: original.type,
        direction: original.direction,
        color: original.color ?? '#000000',
        start: original.start,
        end: original.end,
        qualifiers: { dnaforge_ann_id: ['22222222-2222-4222-8222-222222222222'] },
      })
    ).toThrow(/managed annotation ID/i);
  });
});

describe('native first-stamp managed annotation acknowledgement', () => {
  beforeEach(resetStore);

  it('retains first-stamped annotation identity through post-save Undo and Redo', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const original = ann('legacy feature', 2, 4, { qualifiers: { note: ['retained'] } });
    useSequenceStore.getState().setSequence(DOC, makeSequence({ annotations: [original] }));
    type('A', 0);
    const written = useSequenceStore.getState().captureForSave(DOC)!;
    expect(useSequenceStore.getState().acknowledgeSaved(DOC, written, [id]).settled).toBe(true);
    const saved = useSequenceStore.getState().captureForSave(DOC)!;
    expect(saved.sequence.annotations[0].qualifiers).toEqual({
      note: ['retained'],
      dnaforge_ann_id: [id],
    });
    type('C', 1);
    const edited = useSequenceStore.getState().captureForSave(DOC)!;
    useSequenceStore.getState().dispatchEdit(DOC, { type: 'UNDO' });
    const undone = useSequenceStore.getState().captureForSave(DOC)!;
    expect(undone).toEqual({ ...saved, revision: undone.revision });
    expect(undone.revision).toBeGreaterThan(edited.revision);
    expect(useSequenceStore.getState().isDirty(DOC)).toBe(false);
    useSequenceStore.getState().dispatchEdit(DOC, { type: 'REDO' });
    const redone = useSequenceStore.getState().captureForSave(DOC)!;
    expect(redone).toEqual({ ...edited, revision: redone.revision });
    expect(redone.revision).toBeGreaterThan(undone.revision);
    expect(useSequenceStore.getState().isDirty(DOC)).toBe(true);
    useSequenceStore.getState().dispatchEdit(DOC, { type: 'UNDO' });
    const restored = useSequenceStore.getState().captureForSave(DOC)!;
    expect(restored).toEqual({ ...saved, revision: restored.revision });
    expect(restored.revision).toBeGreaterThan(redone.revision);
    expect(useSequenceStore.getState().savedVersions[DOC]).toBe(written.revision);
    expect(useSequenceStore.getState().isDirty(DOC)).toBe(false);
  });

  it('hydrates saved, working, and draft identity before the next rename', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const original = ann('legacy feature', 2, 4);
    useSequenceStore.getState().setSequence(DOC, makeSequence({ annotations: [original] }));
    const patch = {
      name: 'first rename',
      type: original.type,
      direction: original.direction,
      color: original.color ?? '#000000',
      start: original.start,
      end: original.end,
    };
    useSequenceStore.getState().updateAnnotation(DOC, 0, patch);
    const firstCapture = useSequenceStore.getState().captureForSave(DOC)!;
    expect(firstCapture.sequence.annotations?.[0].qualifiers?.dnaforge_ann_id).toBeUndefined();
    expect(useSequenceStore.getState().acknowledgeSaved(DOC, firstCapture, [id]).settled).toBe(
      true
    );
    const state = useSequenceStore.getState();
    expect(state.savedSequences[DOC]?.annotations?.[0].qualifiers?.dnaforge_ann_id).toEqual([id]);
    expect(state.sequences[DOC]?.annotations?.[0].qualifiers?.dnaforge_ann_id).toEqual([id]);
    expect(state.drafts[DOC]?.annotations?.[0].qualifiers?.dnaforge_ann_id).toEqual([id]);
    expect(state.isDirty(DOC)).toBe(false);

    state.updateAnnotation(DOC, 0, { ...patch, name: 'second rename' });
    const secondCapture = useSequenceStore.getState().captureForSave(DOC)!;
    expect(secondCapture.sequence.annotations?.[0].qualifiers?.dnaforge_ann_id).toEqual([id]);
    expect(() =>
      useSequenceStore
        .getState()
        .acknowledgeSaved(DOC, secondCapture, ['22222222-2222-4222-8222-222222222222'])
    ).toThrow(/managed annotation identity conflicts/i);
    expect(useSequenceStore.getState().isDirty(DOC)).toBe(true);
  });
});

describe('sequence document model — late acknowledgments', () => {
  beforeEach(() => {
    resetStore();
  });

  it('captures one immutable baseline and lineage across later dirty edits', () => {
    loadExample();
    const loaded = useSequenceStore.getState().captureForSave(DOC)!;
    type('TT', 6);
    const firstEdit = useSequenceStore.getState().captureForSave(DOC)!;
    type('GG', 0);
    const secondEdit = useSequenceStore.getState().captureForSave(DOC)!;

    expect(firstEdit.draftBaseline.sequence).toBe(loaded.sequence.sequence);
    expect(secondEdit.draftBaseline.sequence).toBe(loaded.sequence.sequence);
    expect(firstEdit.draftLineageId).toBe(loaded.draftLineageId);
    expect(secondEdit.draftLineageId).toBe(loaded.draftLineageId);
    expect(firstEdit.draftSequence).toBe(firstEdit.sequence.sequence);
    expect(secondEdit.draftSequence).toBe(secondEdit.sequence.sequence);
    expect(firstEdit.insertedRanges).toEqual([{ start: 6, end: 8 }]);
    expect(secondEdit.insertedRanges).toEqual([
      { start: 0, end: 2 },
      { start: 8, end: 10 },
    ]);
  });

  it('keeps the older dirty baseline and lineage after an unsettled acknowledgment', () => {
    loadExample();
    type('TT', 6);
    const written = useSequenceStore.getState().captureForSave(DOC)!;
    type('GG', 0);

    expect(useSequenceStore.getState().acknowledgeSaved(DOC, written).settled).toBe(false);
    const stillDirty = useSequenceStore.getState().captureForSave(DOC)!;
    expect(stillDirty.draftBaseline).toEqual(written.draftBaseline);
    expect(stillDirty.draftLineageId).toBe(written.draftLineageId);
    expect(stillDirty.draftSequence).not.toBe(written.draftSequence);
  });

  it('starts a new baseline and lineage only after a save fully settles', () => {
    loadExample();
    type('TT', 6);
    const written = useSequenceStore.getState().captureForSave(DOC)!;

    expect(useSequenceStore.getState().acknowledgeSaved(DOC, written).settled).toBe(true);
    const settled = useSequenceStore.getState().captureForSave(DOC)!;
    expect(settled.draftBaseline.sequence).toBe(written.sequence.sequence);
    expect(settled.draftSequence).toBe(written.sequence.sequence);
    expect(settled.draftLineageId).not.toBe(written.draftLineageId);
    expect(settled.insertedRanges).toEqual([]);
    expect(settled.deletedRanges).toEqual([]);
    expect(settled.substitutedRanges).toEqual([]);
  });

  it('a discard while a write is in flight leaves the document dirty, not falsely clean', () => {
    loadExample();
    type('TT', 6);
    const capture = useSequenceStore.getState().captureForSave(DOC)!;

    useSequenceStore.getState().discardEdits(DOC);
    expect(useSequenceStore.getState().isDirty(DOC)).toBe(false);

    expect(useSequenceStore.getState().acknowledgeSaved(DOC, capture).settled).toBe(false);
    const state = useSequenceStore.getState();
    expect(state.savedSequences[DOC]?.sequence).toBe('AAAACCTTCCGGGG');
    expect(state.sequences[DOC]?.sequence).toBe('AAAACCCCGGGG');

    expect(state.isDirty(DOC)).toBe(true);
    const next = state.captureForSave(DOC)!;
    expect(next.sequence.sequence).toBe('AAAACCCCGGGG');
    expect(useSequenceStore.getState().acknowledgeSaved(DOC, next).settled).toBe(true);
    expect(useSequenceStore.getState().isDirty(DOC)).toBe(false);
  });

  it('the last acknowledged write is the saved snapshot, whatever order captures were taken in', () => {
    loadExample();
    type('TT', 6);
    const older = useSequenceStore.getState().captureForSave(DOC)!;
    type('GG', 0);
    const newer = useSequenceStore.getState().captureForSave(DOC)!;
    type('CC', 0);

    expect(useSequenceStore.getState().acknowledgeSaved(DOC, newer).settled).toBe(false);
    expect(useSequenceStore.getState().savedSequences[DOC]?.sequence).toBe(newer.sequence.sequence);
    expect(useSequenceStore.getState().acknowledgeSaved(DOC, older).settled).toBe(false);
    expect(useSequenceStore.getState().savedSequences[DOC]?.sequence).toBe(older.sequence.sequence);
    expect(useSequenceStore.getState().isDirty(DOC)).toBe(true);
  });

  it('metadata patched during an unsettled save survives in the saved snapshot', () => {
    loadExample();
    type('TT', 6);
    const capture = useSequenceStore.getState().captureForSave(DOC)!;
    useSequenceStore.getState().patchSavedMetadata(DOC, { circular: true });
    type('GG', 0);
    expect(useSequenceStore.getState().acknowledgeSaved(DOC, capture).settled).toBe(false);
    expect(useSequenceStore.getState().savedSequences[DOC]?.circular).toBe(true);
    expect(useSequenceStore.getState().savedSequences[DOC]?.sequence).toBe('AAAACCTTCCGGGG');
    expect(useSequenceStore.getState().discardEdits(DOC)?.circular).toBe(true);
  });

  it('markClean straight after a load is a no-op', () => {
    loadExample();
    const before = useSequenceStore.getState().revision;
    useSequenceStore.getState().markClean(DOC);
    const state = useSequenceStore.getState();
    expect(state.revision).toBe(before);
    expect(state.drafts[DOC]?.history).toHaveLength(1);
    expect(state.isDirty(DOC)).toBe(false);
  });
});
