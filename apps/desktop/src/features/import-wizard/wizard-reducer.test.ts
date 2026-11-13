import { describe, it, expect } from 'vitest';
import { wizardReducer, confirmButton, type WizardAction } from './wizard-reducer';
import type { ImportWizardState, ImportItem } from '../workspace-loader/import-wizard-state';

function item(name: string, extra: Partial<ImportItem> = {}): ImportItem {
  return { path: `/drop/${name}`, name, kind: 'file', ...extra };
}
function state(over: Partial<ImportWizardState> = {}): ImportWizardState {
  return {
    items: [item('a.gb')],
    destination: { kind: 'existing-root', rootPath: '/ws' },
    requiresExplicitChoice: false,
    destinationChosen: true,
    agentRequested: false,
    ...over,
  };
}

describe('wizardReducer ', () => {
  it('set-destination records the choice and marks it chosen', () => {
    const s = wizardReducer(state({ requiresExplicitChoice: true, destinationChosen: false }), {
      type: 'set-destination',
      destination: { kind: 'new-workspace' },
    });
    expect(s.destination).toEqual({ kind: 'new-workspace' });
    expect(s.destinationChosen).toBe(true);
  });

  it('set-dedup-resolution updates only the targeted item', () => {
    const s0 = state({ items: [item('x.gb'), item('y.gb')] });
    const s = wizardReducer(s0, {
      type: 'set-dedup-resolution',
      path: '/drop/y.gb',
      resolution: 'replace',
    });
    expect(s.items.find((i) => i.name === 'y.gb')?.dedupResolution).toBe('replace');
    expect(s.items.find((i) => i.name === 'x.gb')?.dedupResolution).toBeUndefined();
  });

  it('toggle-agent flips agentRequested', () => {
    expect(wizardReducer(state(), { type: 'toggle-agent', value: true }).agentRequested).toBe(true);
  });

  it('set-items replaces the batch', () => {
    const s = wizardReducer(state(), { type: 'set-items', items: [] });
    expect(s.items).toEqual([]);
  });

  it('add-items appends new items but skips paths already listed', () => {
    const s0 = state({ items: [item('a.gb')] });
    const s = wizardReducer(s0, {
      type: 'add-items',
      items: [item('a.gb'), item('b.gb')],
    });
    expect(s.items.map((i) => i.name)).toEqual(['a.gb', 'b.gb']);
  });

  it('does not re-add a blocked source after its preview was recovered into package rows', () => {
    const current = state({
      items: [
        item('recovered', {
          path: '/drop/unknown.fa::dnaforge-sequence-record:0',
          sourcePath: '/drop/unknown.fa',
        }),
      ],
    });
    const next = wizardReducer(current, {
      type: 'add-items',
      items: [
        item('unknown.fa', {
          path: '/drop/unknown.fa',
          sourcePath: '/drop/unknown.fa',
          block: { kind: 'sequence-preview-failed', message: 'Missing type.' },
        }),
      ],
    });
    expect(next).toBe(current);
  });

  it('add-items with only-duplicate paths is a no-op (same reference)', () => {
    const s0 = state({ items: [item('a.gb')] });
    expect(wizardReducer(s0, { type: 'add-items', items: [item('a.gb')] })).toBe(s0);
  });

  it('set-item-target routes one item without touching others', () => {
    const s0 = state({ items: [item('a.gb'), item('b.gb')] });
    const s = wizardReducer(s0, {
      type: 'set-item-target',
      path: '/drop/b.gb',
      target: { kind: 'existing-root', rootPath: '/ws/x' },
    });
    expect(s.items.find((i) => i.name === 'a.gb')?.target).toBeUndefined();
    expect(s.items.find((i) => i.name === 'b.gb')?.target).toEqual({
      kind: 'existing-root',
      rootPath: '/ws/x',
    });
  });

  it('set-items-target places a batch; unplace-items clears them back to the queue', () => {
    const s0 = state({ items: [item('a.gb'), item('b.gb'), item('c.gb')] });
    const placed = wizardReducer(s0, {
      type: 'set-items-target',
      paths: ['/drop/a.gb', '/drop/c.gb'],
      target: { kind: 'existing-root', rootPath: '/ws/seqs' },
    });
    expect(placed.items.filter((i) => i.target).map((i) => i.name)).toEqual(['a.gb', 'c.gb']);
    const unplaced = wizardReducer(placed, { type: 'unplace-items', paths: ['/drop/a.gb'] });
    expect(unplaced.items.find((i) => i.name === 'a.gb')?.target).toBeUndefined();
    expect(unplaced.items.find((i) => i.name === 'c.gb')?.target).toBeTruthy();
  });

  it('keeps every planned package from one source in the same destination', () => {
    const sourcePath = '/drop/two-real-records.gb';
    const first = item('first', {
      path: `${sourcePath}::dnaforge-sequence-record:0`,
      sourcePath,
    });
    const second = item('second', {
      path: `${sourcePath}::dnaforge-sequence-record:1`,
      sourcePath,
    });
    const s = wizardReducer(state({ items: [first, second, item('other.gb')] }), {
      type: 'set-item-target',
      path: first.path,
      target: { kind: 'existing-root', rootPath: '/ws/sequences' },
    });

    expect(s.items.slice(0, 2).map((entry) => entry.target)).toEqual([
      { kind: 'existing-root', rootPath: '/ws/sequences' },
      { kind: 'existing-root', rootPath: '/ws/sequences' },
    ]);
    expect(s.items[2].target).toBeUndefined();
  });

  it('place-all-unplaced places every remaining importable item, skipping blocked + already-placed', () => {
    const s0 = state({
      items: [
        item('placed.gb', { target: { kind: 'existing-root', rootPath: '/ws/x' } }),
        item('queued.gb'),
        item('pool.fasta', {
          block: { kind: 'multi-record-fasta', recordCount: 3, message: '3 seqs' },
        }),
      ],
    });
    const s = wizardReducer(s0, {
      type: 'place-all-unplaced',
      target: { kind: 'existing-root', rootPath: '/ws/inbox' },
    });
    expect(s.items.find((i) => i.name === 'queued.gb')?.target).toEqual({
      kind: 'existing-root',
      rootPath: '/ws/inbox',
    });
    expect(s.items.find((i) => i.name === 'placed.gb')?.target).toEqual({
      kind: 'existing-root',
      rootPath: '/ws/x',
    });
    expect(s.items.find((i) => i.name === 'pool.fasta')?.target).toBeUndefined();
  });

  it('set-group-target routes a whole bucket in one action', () => {
    const s0 = state({
      items: [
        item('a.gb', { format: 'genbank' }),
        item('b.fasta', { format: 'fasta' }),
        item('c.csv'),
      ],
    });
    const s = wizardReducer(s0, {
      type: 'set-group-target',
      bucket: 'Sequences',
      target: { kind: 'new-workspace' },
    });
    expect(s.items.find((i) => i.name === 'a.gb')?.target).toEqual({ kind: 'new-workspace' });
    expect(s.items.find((i) => i.name === 'b.fasta')?.target).toEqual({ kind: 'new-workspace' });
    expect(s.items.find((i) => i.name === 'c.csv')?.target).toBeUndefined();
  });

  it('is a no-op for an unknown action (returns the same reference)', () => {
    const s0 = state();
    expect(wizardReducer(s0, { type: 'nope' } as unknown as WizardAction)).toBe(s0);
  });
});

describe('confirmButton (derived label/enabled/reason)', () => {
  it('enables with an item-count label for a ready single import', () => {
    const b = confirmButton(state());
    expect(b.enabled).toBe(true);
    expect(b.label).toBe('Import 1 item');
  });

  it('pluralizes and counts only importable items', () => {
    const b = confirmButton(
      state({
        items: [
          item('a.gb'),
          item('b.gb'),
          item('reads.fasta', {
            block: { kind: 'multi-record-fasta', recordCount: 3, message: 'x' },
          }),
        ],
      })
    );
    expect(b.label).toBe('Import 2 items');
  });

  it('relabels when the agent is requested', () => {
    const b = confirmButton(state({ agentRequested: true }));
    expect(b.label.toLowerCase()).toContain('agent');
  });

  it('no longer disables on an unchosen batch destination (transfer-list: placement is the modal gate)', () => {
    const b = confirmButton(state({ requiresExplicitChoice: true, destinationChosen: false }));
    expect(b.enabled).toBe(true);
  });

  it('disables with a reason when a name-collision is unresolved', () => {
    const b = confirmButton(
      state({
        items: [item('dup.gb', { dedup: { action: 'name-collision', existingRelPath: 'dup.gb' } })],
      })
    );
    expect(b.enabled).toBe(false);
    expect(b.reason?.toLowerCase()).toContain('conflict');
  });
});
