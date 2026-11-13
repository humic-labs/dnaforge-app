import { describe, it, expect } from 'vitest';
import {
  isPlaced,
  itemDestination,
  unplacedItems,
  itemsPlacedAt,
  itemsPlacedNewWorkspace,
  allImportablePlaced,
} from './import-placement';
import type { ImportItem } from '../workspace-loader/import-wizard-state';

function f(name: string, extra: Partial<ImportItem> = {}): ImportItem {
  return { path: `/d/${name}`, name, kind: 'file', ...extra };
}

describe('import-placement  transfer-list manifest)', () => {
  it('an item with no target (or default) is UNPLACED; an explicit target is placed', () => {
    expect(isPlaced(f('a.gb'))).toBe(false);
    expect(isPlaced(f('a.gb', { target: { kind: 'default' } }))).toBe(false);
    expect(isPlaced(f('a.gb', { target: { kind: 'existing-root', rootPath: '/ws' } }))).toBe(true);
    expect(isPlaced(f('a.gb', { target: { kind: 'new-workspace' } }))).toBe(true);
  });

  it('itemDestination is null while queued, the concrete dest once placed', () => {
    expect(itemDestination(f('a.gb'))).toBeNull();
    expect(
      itemDestination(f('a.gb', { target: { kind: 'existing-root', rootPath: '/ws' } }))
    ).toEqual({
      kind: 'existing-root',
      rootPath: '/ws',
    });
  });

  it('partitions the queue vs the placed items by destination', () => {
    const items = [
      f('queued1.gb'),
      f('queued2.gb'),
      f('inSeqs.gb', { target: { kind: 'existing-root', rootPath: '/ws/sequences' } }),
      f('inReads.fastq', { target: { kind: 'existing-root', rootPath: '/ws/reads' } }),
      f('inNew.gb', { target: { kind: 'new-workspace' } }),
    ];
    expect(unplacedItems(items).map((i) => i.name)).toEqual(['queued1.gb', 'queued2.gb']);
    expect(itemsPlacedAt(items, '/ws/sequences').map((i) => i.name)).toEqual(['inSeqs.gb']);
    expect(itemsPlacedNewWorkspace(items).map((i) => i.name)).toEqual(['inNew.gb']);
  });

  it('allImportablePlaced ignores blocked items but requires every other item placed', () => {
    const blocked = f('pool.fasta', {
      block: { kind: 'multi-record-fasta', recordCount: 3, message: '3 seqs' },
    });
    expect(allImportablePlaced([f('a.gb'), blocked])).toBe(false);
    expect(
      allImportablePlaced([
        f('a.gb', { target: { kind: 'existing-root', rootPath: '/ws' } }),
        blocked,
      ])
    ).toBe(true);
  });
});
