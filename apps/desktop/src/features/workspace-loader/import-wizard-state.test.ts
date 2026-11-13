import { describe, it, expect } from 'vitest';
import { canConfirmImport, type ImportWizardState, type ImportItem } from './import-wizard-state';

function item(name: string, extra: Partial<ImportItem> = {}): ImportItem {
  return { path: `/drop/${name}`, name, kind: 'file', ...extra };
}

function baseState(over: Partial<ImportWizardState> = {}): ImportWizardState {
  return {
    items: [item('a.gb')],
    destination: { kind: 'existing-root', rootPath: '/ws' },
    requiresExplicitChoice: false,
    destinationChosen: true,
    agentRequested: false,
    ...over,
  };
}

describe('canConfirmImport  wizard state)', () => {
  it('confirms a simple single-file import into a preselected destination', () => {
    expect(canConfirmImport(baseState())).toEqual({ canConfirm: true });
  });

  it('blocks when there is nothing to import', () => {
    const r = canConfirmImport(baseState({ items: [] }));
    expect(r.canConfirm).toBe(false);
    expect(r.reason).toBe('no-items');
  });

  it('no longer gates on destination choice (transfer-list pivot — placement is the modal gate)', () => {
    expect(
      canConfirmImport(baseState({ requiresExplicitChoice: true, destinationChosen: false }))
        .canConfirm
    ).toBe(true);
  });

  it('blocks when EVERY item is fail-closed blocked (e.g. a lone multi-FASTA)', () => {
    const r = canConfirmImport(
      baseState({
        items: [
          item('reads.fasta', {
            block: { kind: 'multi-record-fasta', recordCount: 4, message: 'x' },
          }),
        ],
      })
    );
    expect(r.canConfirm).toBe(false);
    expect(r.reason).toBe('all-blocked');
  });

  it('allows a mixed batch where SOME items are importable (blocked ones are skipped)', () => {
    const r = canConfirmImport(
      baseState({
        items: [
          item('ok.gb'),
          item('reads.fasta', {
            block: { kind: 'multi-record-fasta', recordCount: 4, message: 'x' },
          }),
        ],
      })
    );
    expect(r.canConfirm).toBe(true);
  });

  it('does not describe a blocked and duplicate batch as entirely already imported', () => {
    expect(
      canConfirmImport(
        baseState({
          items: [
            item('blocked.fa', {
              block: { kind: 'sequence-preview-failed', message: 'DNA identity is unconfirmed' },
            }),
            item('duplicate.gb', {
              dedup: { action: 'skip-duplicate', existingRelPath: 'orig.gb', matchedByName: false },
            }),
          ],
        })
      )
    ).toEqual({ canConfirm: false, reason: 'all-blocked' });
  });

  it('blocks until an unresolved name-collision is resolved (Replace / Keep-both)', () => {
    const r = canConfirmImport(
      baseState({
        items: [item('dup.gb', { dedup: { action: 'name-collision', existingRelPath: 'dup.gb' } })],
      })
    );
    expect(r.canConfirm).toBe(false);
    expect(r.reason).toBe('resolve-collisions');
  });

  it('confirms once a name-collision has a resolution', () => {
    const r = canConfirmImport(
      baseState({
        items: [
          item('dup.gb', {
            dedup: { action: 'name-collision', existingRelPath: 'dup.gb' },
            dedupResolution: 'keep-both',
          }),
        ],
      })
    );
    expect(r.canConfirm).toBe(true);
  });

  it('does not require action for a skip-duplicate item (it just skips)', () => {
    const r = canConfirmImport(
      baseState({
        items: [
          item('ok.gb'),
          item('twin.gb', {
            dedup: { action: 'skip-duplicate', existingRelPath: 'orig.gb', matchedByName: false },
          }),
        ],
      })
    );
    expect(r.canConfirm).toBe(true);
  });
});
