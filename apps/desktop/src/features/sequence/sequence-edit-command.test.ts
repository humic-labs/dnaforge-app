// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { useSequenceStore } from './store';
import { applySequenceEditCommand, inspectSequenceEditState } from './sequence-edit-command';

const id = 'parity-sequence';
beforeEach(() => {
  useSequenceStore.getState().clearAll();
  useSequenceStore.getState().setSequence(id, {
    id,
    name: 'parity',
    sequence: 'AAAACCCCGGGG',
    length: 12,
    circular: false,
    annotations: [{ name: 'Cs', type: 'misc_feature', start: 5, end: 8, direction: 1 }],
    metadata: {},
  });
});
const version = () => useSequenceStore.getState().getVersion(id);
const run = (operation: Parameters<typeof applySequenceEditCommand>[0]['operation']) =>
  applySequenceEditCommand({ documentId: id, expectedVersion: version(), operation });

describe('human and agent sequence command parity', () => {
  it('inserts a larger sequence through the native draft and restores it with undo', () => {
    const before = inspectSequenceEditState(id);
    const bases = 'A'.repeat(50_001);
    expect(run({ kind: 'replace-bases', start: 0, end: 0, bases, expectedBases: '' }).ok).toBe(
      true
    );
    expect(inspectSequenceEditState(id).sequence).toBe(bases + before.sequence);
    expect(run({ kind: 'undo' }).ok).toBe(true);
    expect(inspectSequenceEditState(id).sequence).toBe(before.sequence);
    expect(inspectSequenceEditState(id).annotations).toEqual(before.annotations);
  });

  it('uses working coordinates after pending deletions and preserves the native undo path', () => {
    expect(
      run({ kind: 'replace-bases', start: 0, end: 4, bases: '', expectedBases: 'AAAA' }).ok
    ).toBe(true);
    expect(
      run({ kind: 'replace-bases', start: 4, end: 4, bases: 'TT', expectedBases: '' }).ok
    ).toBe(true);
    expect(inspectSequenceEditState(id).sequence).toBe('CCCCTTGGGG');
    expect(run({ kind: 'undo' }).ok).toBe(true);
    expect(inspectSequenceEditState(id).sequence).toBe('CCCCGGGG');
    expect(run({ kind: 'redo' }).ok).toBe(true);
    expect(inspectSequenceEditState(id).sequence).toBe('CCCCTTGGGG');
    expect(run({ kind: 'discard' }).ok).toBe(true);
    expect(inspectSequenceEditState(id)).toMatchObject({ sequence: 'AAAACCCCGGGG', dirty: false });
  });

  it('rejects an outdated observation after a human edit without changing the newer draft', () => {
    const observed = version();
    useSequenceStore.getState().dispatchEdit(id, { type: 'INSERT', text: 'T' });
    const before = useSequenceStore.getState().captureForSave(id);
    expect(
      applySequenceEditCommand({
        documentId: id,
        expectedVersion: observed,
        operation: { kind: 'discard' },
      })
    ).toMatchObject({ ok: false, code: 'STALE_SEQUENCE' });
    expect(useSequenceStore.getState().captureForSave(id)).toEqual(before);
  });

  it.each([
    { kind: 'replace-bases', start: 0, end: 20, bases: '', expectedBases: '' },
    { kind: 'replace-bases', start: 0, end: 1, bases: 'Z', expectedBases: 'A' },
    { kind: 'replace-bases', start: 0, end: 1, bases: 'T', expectedBases: 'C' },
    { kind: 'delete-annotation', index: 99 },
  ] as const)('refuses invalid edits atomically: %j', (operation) => {
    const before = useSequenceStore.getState().captureForSave(id);
    expect(run(operation).ok).toBe(false);
    expect(useSequenceStore.getState().captureForSave(id)).toEqual(before);
  });

  it('edits annotations through the same store and restores exact qualifiers on undo', () => {
    const annotation = {
      name: 'curated',
      type: 'CDS',
      start: 1,
      end: 3,
      direction: -1 as const,
      color: '#445566',
      qualifiers: { note: ['evidence'] },
    };
    expect(run({ kind: 'add-annotation', annotation }).ok).toBe(true);
    expect(inspectSequenceEditState(id).annotations[0]).toMatchObject(annotation);
    expect(
      run({ kind: 'update-annotation', index: 0, annotation: { ...annotation, name: 'revised' } })
        .ok
    ).toBe(true);
    expect(run({ kind: 'undo' }).ok).toBe(true);
    expect(inspectSequenceEditState(id).annotations[0]).toMatchObject(annotation);
    expect(run({ kind: 'delete-annotation', index: 0 }).ok).toBe(true);
    expect(inspectSequenceEditState(id).annotations.map((a) => a.name)).toEqual(['Cs']);
  });
});
