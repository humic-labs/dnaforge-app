import { describe, it, expect } from 'vitest';
import { planImportWrites } from './plan-import-writes';
import type { ImportWizardOutcome } from './import-wizard-store';
import type { ImportItem } from '../workspace-loader/import-wizard-state';

function file(name: string, extra: Partial<ImportItem> = {}): ImportItem {
  return { path: `/drop/${name}`, name, kind: 'file', ...extra };
}
function outcome(over: Partial<ImportWizardOutcome> = {}): ImportWizardOutcome {
  return {
    items: [file('a.gb')],
    destination: { kind: 'existing-root', rootPath: '/ws' },
    agentRequested: false,
    ...over,
  };
}

describe('planImportWrites  single funnel)', () => {
  it('plans a plain file import into an existing root (no dedup)', () => {
    const plan = planImportWrites(outcome());
    expect(plan).toEqual([
      { kind: 'import-file', sourcePath: '/drop/a.gb', targetRoot: '/ws', dedup: undefined },
    ]);
  });

  it('plans a typed DNA sequence as one managed copy plus automatic Registry projection', () => {
    const plan = planImportWrites(
      outcome({
        importIntent: { entityType: 'dna-sequences' },
        items: [
          file('sequence.gb', {
            dedup: { action: 'name-collision', existingRelPath: 'sequence.gb' },
            dedupResolution: 'keep-both',
            expectedSourceSha256: 'a'.repeat(64),
            confirmedDnaSourceSha256: 'a'.repeat(64),
          }),
        ],
      })
    );

    expect(plan).toEqual([
      {
        kind: 'register-entities',
        sourcePath: '/drop/sequence.gb',
        targetRoot: '/ws',
        dedup: { mode: 'keep-both' },
        expectedSourceSha256: 'a'.repeat(64),
        confirmedDnaSourceSha256: 'a'.repeat(64),
      },
    ]);
  });

  it('carries the confirmed digest through a direct Registry destination', () => {
    const plan = planImportWrites(
      outcome({
        importIntent: { entityType: 'dna-sequences' },
        items: [
          file('sequence.gb', {
            target: { kind: 'registry' },
            expectedSourceSha256: 'b'.repeat(64),
          }),
        ],
      })
    );

    expect(plan).toEqual([
      {
        kind: 'register-entities',
        sourcePath: '/drop/sequence.gb',
        expectedSourceSha256: 'b'.repeat(64),
      },
    ]);
  });

  it('refuses an unresolved new-project DNA route instead of bypassing registration', () => {
    expect(() =>
      planImportWrites(
        outcome({
          importIntent: { entityType: 'dna-sequences' },
          destination: { kind: 'new-workspace' },
          items: [file('sequence.gb', { expectedSourceSha256: 'c'.repeat(64) })],
        })
      )
    ).toThrow(/must be resolved before write planning/i);
  });

  it('plans one atomic write for every package previewed from one multi-record source', () => {
    const sourcePath = '/drop/two-real-records.gb';
    const target = { kind: 'existing-root' as const, rootPath: '/ws/sequences' };
    const plan = planImportWrites(
      outcome({
        importIntent: { entityType: 'dna-sequences' },
        items: [
          file('first', {
            path: `${sourcePath}::dnaforge-sequence-record:0`,
            sourcePath,
            target,
          }),
          file('second', {
            path: `${sourcePath}::dnaforge-sequence-record:1`,
            sourcePath,
            target,
          }),
        ],
      })
    );

    expect(plan).toEqual([
      {
        kind: 'register-entities',
        sourcePath,
        targetRoot: '/ws/sequences',
        dedup: undefined,
      },
    ]);
  });

  it('refuses to split packages from one source across destinations', () => {
    const sourcePath = '/drop/two-real-records.gb';
    expect(() =>
      planImportWrites(
        outcome({
          importIntent: { entityType: 'dna-sequences' },
          items: [
            file('first', {
              path: `${sourcePath}::dnaforge-sequence-record:0`,
              sourcePath,
              target: { kind: 'existing-root', rootPath: '/ws/a' },
            }),
            file('second', {
              path: `${sourcePath}::dnaforge-sequence-record:1`,
              sourcePath,
              target: { kind: 'existing-root', rootPath: '/ws/b' },
            }),
          ],
        })
      )
    ).toThrow('must share one destination');
  });

  it('carries a Replace resolution as dedup mode replace with the expected path', () => {
    const plan = planImportWrites(
      outcome({
        items: [
          file('dup.gb', {
            dedup: { action: 'name-collision', existingRelPath: 'dup.gb' },
            dedupResolution: 'replace',
          }),
        ],
      })
    );
    expect(plan[0]).toMatchObject({
      kind: 'import-file',
      dedup: { mode: 'replace', expectedRelPath: 'dup.gb' },
    });
  });

  it('carries Keep-both as dedup mode keep-both', () => {
    const plan = planImportWrites(
      outcome({
        items: [
          file('dup.gb', {
            dedup: { action: 'name-collision', existingRelPath: 'dup.gb' },
            dedupResolution: 'keep-both',
          }),
        ],
      })
    );
    expect(plan[0]).toMatchObject({ kind: 'import-file', dedup: { mode: 'keep-both' } });
  });

  it('SKIPS a skip-duplicate item by default', () => {
    const plan = planImportWrites(
      outcome({
        items: [
          file('twin.gb', {
            dedup: { action: 'skip-duplicate', existingRelPath: 'orig.gb', matchedByName: false },
          }),
        ],
      })
    );
    expect(plan).toEqual([{ kind: 'skip', reason: 'duplicate', sourcePath: '/drop/twin.gb' }]);
  });

  it('writes a skip-duplicate item when overridden with import-anyway (as keep-both)', () => {
    const plan = planImportWrites(
      outcome({
        items: [
          file('twin.gb', {
            dedup: { action: 'skip-duplicate', existingRelPath: 'orig.gb', matchedByName: false },
            dedupResolution: 'import-anyway',
          }),
        ],
      })
    );
    expect(plan[0]).toMatchObject({ kind: 'import-file', dedup: { mode: 'keep-both' } });
  });

  it('SKIPS a fail-closed blocked item', () => {
    const plan = planImportWrites(
      outcome({
        items: [
          file('multi.fasta', {
            block: { kind: 'multi-record-fasta', recordCount: 3, message: 'x' },
          }),
        ],
      })
    );
    expect(plan).toEqual([{ kind: 'skip', reason: 'blocked', sourcePath: '/drop/multi.fasta' }]);
  });

  it('plans a folder into an existing root as import-folder', () => {
    const plan = planImportWrites(
      outcome({ items: [{ path: '/drop/Proj', name: 'Proj', kind: 'folder' }] })
    );
    expect(plan[0]).toEqual({ kind: 'import-folder', sourcePath: '/drop/Proj', targetRoot: '/ws' });
  });

  it('plans a folder into a new workspace as new-workspace-from-folder', () => {
    const plan = planImportWrites(
      outcome({
        destination: { kind: 'new-workspace' },
        items: [{ path: '/drop/Proj', name: 'Proj', kind: 'folder' }],
      })
    );
    expect(plan[0]).toEqual({ kind: 'new-workspace-from-folder', sourcePath: '/drop/Proj' });
  });
});
