import { userMessage } from '@waypoint/user-messages';
import { describe, it, expect, beforeEach } from 'vitest';
import { useAnnotationReviewStore } from './annotation-review-store';
import type { DraftAnnotation } from './types';

const FILE_A = '/path/to/file-a.gb';
const FILE_B = '/path/to/file-b.gb';

function createTestDraft(overrides: Partial<DraftAnnotation> = {}): DraftAnnotation {
  return {
    id: `draft-${Math.random()}`,
    name: 'Test Feature',
    start: 100,
    end: 500,
    strand: 1,
    identity: 95,
    coverage: 90,
    ref_start: 1,
    ref_end: 400,
    ref_length: 400,
    db_source: 'protein',
    fragment: false,
    confidence: 85.5,
    accepted: true,
    duplicateStatus: { isDuplicate: false },
    ...overrides,
  };
}

describe('useAnnotationReviewStore', () => {
  beforeEach(() => {
    useAnnotationReviewStore.getState().reset();
  });

  it('keeps file review independent of a managed run and preserves choices during save retry', () => {
    const store = useAnnotationReviewStore.getState();
    store.enterOutputReview([createTestDraft({ id: 'output-hash:0' })], FILE_A, 4, {
      source: { kind: 'workspace-relative', path: 'results.json' },
      format: 'json',
      outputSha256: 'output-hash',
      targetDocumentRevision: 'before',
    });
    store.rejectAll(FILE_A);
    store.setOutputReviewRetryRevision(FILE_A, 'after-owned-edit');
    const session = store.getSession(FILE_A);
    expect(session?.operationId).toBeUndefined();
    expect(session?.inputRevision).toBeUndefined();
    expect(session?.drafts[0].accepted).toBe(false);
    expect(session?.outputImport?.targetDocumentRevision).toBe('after-owned-edit');
    store.exitReviewMode(FILE_A);
    expect(store.getSession(FILE_A)).toBeUndefined();
  });

  it('keeps independent reviews for two operations on the same document', () => {
    const store = useAnnotationReviewStore.getState();
    store.enterReviewMode([createTestDraft({ id: 'first' })], FILE_A, 3, {
      operationId: 'operation-a',
      inputRevision: 'revision-a',
    });
    store.rejectDraft(FILE_A, 'first');
    store.enterReviewMode([createTestDraft({ id: 'second' })], FILE_A, 4, {
      operationId: 'operation-b',
      inputRevision: 'revision-b',
    });
    expect(store.getSession(FILE_A)?.operationId).toBe('operation-b');
    store.presentOperationReview('operation-a');
    expect(store.getSession(FILE_A)?.drafts[0].accepted).toBe(false);
    expect(store.getSession(FILE_A)?.inputRevision).toBe('revision-a');
    expect(store.getSession(FILE_A)?.runVersion).toBe(3);
  });

  it('does not reinitialize choices or resurrect a dismissed result on repeated delivery', () => {
    const store = useAnnotationReviewStore.getState();
    const context = { operationId: 'operation-a', inputRevision: 'revision-a' };
    store.enterReviewMode([createTestDraft({ id: 'first' })], FILE_A, 3, context);
    store.rejectDraft(FILE_A, 'first');
    store.enterReviewMode([createTestDraft({ id: 'repeated' })], FILE_A, 9, context);
    expect(store.getSession(FILE_A)?.drafts[0]).toMatchObject({ id: 'first', accepted: false });
    store.exitReviewMode(FILE_A);
    store.enterReviewMode([createTestDraft({ id: 'repeated' })], FILE_A, 9, context);
    expect(store.getSession(FILE_A)).toBeUndefined();
    expect(useAnnotationReviewStore.getState().sessions['operation-a'].disposition).toBe(
      'dismissed'
    );
    store.presentOperationReview('operation-a');
    expect(store.getSession(FILE_A)?.drafts[0].accepted).toBe(false);
    store.acceptAll(FILE_A);
    expect(store.getSession(FILE_A)?.drafts[0].accepted).toBe(false);
  });

  it.each(['applied', 'dismissed'] as const)(
    'clears applicability checks after a review is %s and ignores late checks',
    (disposition) => {
      const store = useAnnotationReviewStore.getState();
      store.enterReviewMode([createTestDraft()], FILE_A, 3, {
        operationId: 'operation-a',
        inputRevision: 'revision-a',
      });
      store.setOperationBlockedReason('operation-a', userMessage('annotation.checkingRevision'));
      store.setOperationDisposition('operation-a', disposition);
      expect(
        useAnnotationReviewStore.getState().sessions['operation-a'].blockedReason
      ).toBeUndefined();
      store.setOperationBlockedReason('operation-a', userMessage('annotation.documentChanged'));
      expect(
        useAnnotationReviewStore.getState().sessions['operation-a'].blockedReason
      ).toBeUndefined();
    }
  );

  it('clears an unfinished applicability check when review is dismissed from the document', () => {
    const store = useAnnotationReviewStore.getState();
    store.enterReviewMode([createTestDraft()], FILE_A, 3, {
      operationId: 'operation-a',
      inputRevision: 'revision-a',
    });
    store.setOperationBlockedReason('operation-a', userMessage('annotation.checkingRevision'));
    store.exitReviewMode(FILE_A);
    expect(useAnnotationReviewStore.getState().sessions['operation-a']).toMatchObject({
      disposition: 'dismissed',
      blockedReason: undefined,
    });
  });

  describe('initial state', () => {
    it('starts with no active sessions', () => {
      const state = useAnnotationReviewStore.getState();
      expect(state.sessions).toEqual({});
      expect(state.isActive(FILE_A)).toBe(false);
    });
  });

  describe('enterReviewMode', () => {
    it('creates a session for the given file', () => {
      const drafts = [createTestDraft({ id: 'draft-1' }), createTestDraft({ id: 'draft-2' })];

      useAnnotationReviewStore.getState().enterReviewMode(drafts, FILE_A);

      const state = useAnnotationReviewStore.getState();
      expect(state.isActive(FILE_A)).toBe(true);
      expect(state.getSession(FILE_A)?.drafts).toHaveLength(2);
      expect(state.getSession(FILE_A)?.selectedId).toBe('draft-1');
    });

    it('selects first draft on enter', () => {
      useAnnotationReviewStore
        .getState()
        .enterReviewMode(
          [createTestDraft({ id: 'draft-1' }), createTestDraft({ id: 'draft-2' })],
          FILE_A
        );

      expect(useAnnotationReviewStore.getState().getSession(FILE_A)?.selectedId).toBe('draft-1');
    });

    it('sets selectedId to null when entering with empty drafts', () => {
      useAnnotationReviewStore.getState().enterReviewMode([], FILE_A);

      expect(useAnnotationReviewStore.getState().getSession(FILE_A)?.selectedId).toBeNull();
    });
  });

  describe('concurrent sessions', () => {
    it('supports concurrent review sessions for different files', () => {
      const store = useAnnotationReviewStore.getState();
      store.enterReviewMode([createTestDraft({ id: 'a1' })], FILE_A);
      store.enterReviewMode([createTestDraft({ id: 'b1' })], FILE_B);

      expect(store.getSession(FILE_A)?.drafts).toHaveLength(1);
      expect(store.getSession(FILE_B)?.drafts).toHaveLength(1);
      expect(store.getSession(FILE_A)?.drafts[0].id).toBe('a1');
      expect(store.getSession(FILE_B)?.drafts[0].id).toBe('b1');
    });

    it('exitReviewMode only clears the targeted session', () => {
      const store = useAnnotationReviewStore.getState();
      store.enterReviewMode([createTestDraft({ id: 'a1' })], FILE_A);
      store.enterReviewMode([createTestDraft({ id: 'b1' })], FILE_B);

      store.exitReviewMode(FILE_A);

      expect(store.getSession(FILE_A)).toBeUndefined();
      expect(store.isActive(FILE_A)).toBe(false);
      expect(store.getSession(FILE_B)?.drafts).toHaveLength(1);
      expect(store.isActive(FILE_B)).toBe(true);
    });

    it('actions on one session do not affect another', () => {
      const store = useAnnotationReviewStore.getState();
      store.enterReviewMode(
        [
          createTestDraft({ id: 'a1', accepted: false }),
          createTestDraft({ id: 'a2', accepted: false }),
        ],
        FILE_A
      );
      store.enterReviewMode([createTestDraft({ id: 'b1', accepted: false })], FILE_B);

      store.acceptAll(FILE_A);

      const sessionA = useAnnotationReviewStore.getState().getSession(FILE_A);
      const sessionB = useAnnotationReviewStore.getState().getSession(FILE_B);
      expect(sessionA?.drafts.every((d) => d.accepted)).toBe(true);
      expect(sessionB?.drafts[0].accepted).toBe(false);
    });
  });

  describe('exitReviewMode', () => {
    it('removes the session entirely', () => {
      useAnnotationReviewStore.getState().enterReviewMode([createTestDraft()], FILE_A);

      useAnnotationReviewStore.getState().exitReviewMode(FILE_A);

      const state = useAnnotationReviewStore.getState();
      expect(state.isActive(FILE_A)).toBe(false);
      expect(state.getSession(FILE_A)).toBeUndefined();
    });
  });

  describe('selectDraft', () => {
    it('updates selected id and sets highlight request', () => {
      useAnnotationReviewStore
        .getState()
        .enterReviewMode(
          [
            createTestDraft({ id: 'draft-1', start: 100, end: 200 }),
            createTestDraft({ id: 'draft-2', start: 300, end: 400 }),
            createTestDraft({ id: 'draft-3', start: 500, end: 600 }),
          ],
          FILE_A
        );

      useAnnotationReviewStore.getState().selectDraft(FILE_A, 'draft-2');

      const session = useAnnotationReviewStore.getState().getSession(FILE_A);
      expect(session?.selectedId).toBe('draft-2');
      expect(session?.highlightRequest).not.toBeNull();
      expect(session?.highlightRequest?.start).toBe(299);
      expect(session?.highlightRequest?.end).toBe(399);
    });

    it('sets highlightRequest to null for unknown id', () => {
      useAnnotationReviewStore
        .getState()
        .enterReviewMode([createTestDraft({ id: 'draft-1' })], FILE_A);

      useAnnotationReviewStore.getState().selectDraft(FILE_A, 'unknown-id');

      expect(useAnnotationReviewStore.getState().getSession(FILE_A)?.highlightRequest).toBeNull();
    });

    it('detects origin-spanning annotations (end < start)', () => {
      useAnnotationReviewStore
        .getState()
        .enterReviewMode(
          [createTestDraft({ id: 'origin-spanning', start: 9000, end: 100 })],
          FILE_A
        );

      useAnnotationReviewStore.getState().selectDraft(FILE_A, 'origin-spanning');

      expect(useAnnotationReviewStore.getState().getSession(FILE_A)?.highlightRequest?.wraps).toBe(
        true
      );
    });
  });

  describe('toggleDraftAccepted', () => {
    it('toggles accepted state of a draft by id', () => {
      useAnnotationReviewStore
        .getState()
        .enterReviewMode(
          [
            createTestDraft({ id: 'draft-1', accepted: true }),
            createTestDraft({ id: 'draft-2', accepted: false }),
          ],
          FILE_A
        );

      useAnnotationReviewStore.getState().toggleDraftAccepted(FILE_A, 'draft-1');

      const drafts = useAnnotationReviewStore.getState().getSession(FILE_A)?.drafts;
      expect(drafts?.find((d) => d.id === 'draft-1')?.accepted).toBe(false);
      expect(drafts?.find((d) => d.id === 'draft-2')?.accepted).toBe(false);
    });
  });

  describe('acceptDraft / rejectDraft', () => {
    beforeEach(() => {
      useAnnotationReviewStore
        .getState()
        .enterReviewMode(
          [
            createTestDraft({ id: 'draft-1', accepted: false }),
            createTestDraft({ id: 'draft-2', accepted: true }),
          ],
          FILE_A
        );
    });

    it('acceptDraft sets accepted to true', () => {
      useAnnotationReviewStore.getState().acceptDraft(FILE_A, 'draft-1');
      expect(useAnnotationReviewStore.getState().getSession(FILE_A)?.drafts[0].accepted).toBe(true);
    });

    it('rejectDraft sets accepted to false', () => {
      useAnnotationReviewStore.getState().rejectDraft(FILE_A, 'draft-2');
      expect(useAnnotationReviewStore.getState().getSession(FILE_A)?.drafts[1].accepted).toBe(
        false
      );
    });
  });

  describe('acceptAll / rejectAll', () => {
    beforeEach(() => {
      useAnnotationReviewStore
        .getState()
        .enterReviewMode(
          [
            createTestDraft({ id: 'draft-1', accepted: false }),
            createTestDraft({ id: 'draft-2', accepted: true }),
            createTestDraft({ id: 'draft-3', accepted: false }),
          ],
          FILE_A
        );
    });

    it('acceptAll sets all drafts to accepted', () => {
      useAnnotationReviewStore.getState().acceptAll(FILE_A);

      const drafts = useAnnotationReviewStore.getState().getSession(FILE_A)?.drafts;
      expect(drafts?.every((d) => d.accepted)).toBe(true);
    });

    it('rejectAll sets all drafts to rejected', () => {
      useAnnotationReviewStore.getState().rejectAll(FILE_A);

      const drafts = useAnnotationReviewStore.getState().getSession(FILE_A)?.drafts;
      expect(drafts?.every((d) => !d.accepted)).toBe(true);
    });
  });

  describe('getAcceptedDrafts', () => {
    it('returns only accepted drafts for the given file', () => {
      useAnnotationReviewStore
        .getState()
        .enterReviewMode(
          [
            createTestDraft({ id: 'draft-1', accepted: true }),
            createTestDraft({ id: 'draft-2', accepted: false }),
            createTestDraft({ id: 'draft-3', accepted: true }),
          ],
          FILE_A
        );

      const accepted = useAnnotationReviewStore.getState().getAcceptedDrafts(FILE_A);

      expect(accepted).toHaveLength(2);
      expect(accepted.map((d) => d.id)).toEqual(['draft-1', 'draft-3']);
    });

    it('returns empty array for unknown file', () => {
      expect(useAnnotationReviewStore.getState().getAcceptedDrafts('/unknown')).toEqual([]);
    });
  });

  describe('run version tracking', () => {
    it('stores runVersion when entering review mode', () => {
      useAnnotationReviewStore.getState().enterReviewMode([createTestDraft()], FILE_A, 3);
      expect(useAnnotationReviewStore.getState().sessions[FILE_A].runVersion).toBe(3);
    });

    it('defaults runVersion to 0 when not provided', () => {
      useAnnotationReviewStore.getState().enterReviewMode([createTestDraft()], FILE_A);
      expect(useAnnotationReviewStore.getState().sessions[FILE_A].runVersion).toBe(0);
    });
  });

  describe('getSelectedDraft', () => {
    it('returns the currently selected draft', () => {
      useAnnotationReviewStore
        .getState()
        .enterReviewMode(
          [
            createTestDraft({ id: 'draft-1', name: 'First' }),
            createTestDraft({ id: 'draft-2', name: 'Second' }),
          ],
          FILE_A
        );

      useAnnotationReviewStore.getState().selectDraft(FILE_A, 'draft-2');

      const selected = useAnnotationReviewStore.getState().getSelectedDraft(FILE_A);
      expect(selected?.name).toBe('Second');
    });

    it('returns undefined when no session exists', () => {
      const selected = useAnnotationReviewStore.getState().getSelectedDraft('/unknown');
      expect(selected).toBeUndefined();
    });
  });
});
