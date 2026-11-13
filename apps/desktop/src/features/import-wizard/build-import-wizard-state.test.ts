import { describe, it, expect, vi } from 'vitest';
import { buildImportWizardState, type BuildWizardStateCtx } from './build-import-wizard-state';
import type { WorkspaceFolder } from '../../stores/workspaceStore';

function folder(path: string): WorkspaceFolder {
  return { path, name: path.split('/').pop() ?? path, addedAt: 0 };
}
function ctx(over: Partial<BuildWizardStateCtx> = {}): BuildWizardStateCtx {
  return {
    folders: [folder('/ws')],
    stat: vi.fn(async (p: string) => ({
      isDirectory: p.endsWith('/dir') || !p.includes('.'),
      size: 100,
    })),
    readText: vi.fn(async () => 'LOCUS x 100 bp\n'),
    previewDedup: vi.fn(async () => []),
    previewSequenceImport: vi.fn(async (sourcePath: string) => ({
      kind: 'ready' as const,
      sourcePath,
      sourceSha256: 'a'.repeat(64),
      packages: [
        {
          name:
            sourcePath
              .split('/')
              .pop()
              ?.replace(/\.[^.]+$/, '') ?? 'sequence',
          recordIndex: 0,
          recordCount: 1,
        },
      ],
    })),
    ...over,
  };
}

describe('buildImportWizardState ', () => {
  it('builds a single-file item into the sole workspace with a format badge', async () => {
    const state = await buildImportWizardState(['/drop/pUC19.gb'], ctx());
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ name: 'pUC19.gb', kind: 'file', format: 'genbank' });
    expect(state.destination).toEqual({ kind: 'existing-root', rootPath: '/ws' });
    expect(state.destinationChosen).toBe(true);
  });

  it('pre-places a type-first launch in the folder that opened the picker', async () => {
    const state = await buildImportWizardState(
      ['/drop/pUC19.gb'],
      ctx({
        initialDestinationPath: '/ws/sequences',
        importIntent: { entityType: 'dna-sequences' },
      })
    );

    expect(state.destination).toEqual({
      kind: 'existing-root',
      rootPath: '/ws/sequences',
    });
    expect(state.items[0].target).toEqual({
      kind: 'existing-root',
      rootPath: '/ws/sequences',
    });
    expect(state.importIntent).toEqual({ entityType: 'dna-sequences' });
  });

  it('forces Registry-origin DNA import to choose a destination despite one open project', async () => {
    const state = await buildImportWizardState(
      ['/drop/pUC19.gb'],
      ctx({
        selectedPath: '/ws/stale-files-selection',
        forceExplicitDestination: true,
        importIntent: { entityType: 'dna-sequences' },
      })
    );

    expect(state.requiresExplicitChoice).toBe(true);
    expect(state.destinationChosen).toBe(false);
    expect(state.items[0].target).toBeUndefined();
  });

  it('defaults a folder drop with no workspace to a new workspace', async () => {
    const state = await buildImportWizardState(
      ['/drop/Proj'],
      ctx({
        folders: [],
        stat: vi.fn(async () => ({ isDirectory: true, size: 0 })),
      })
    );
    expect(state.items[0].kind).toBe('folder');
    expect(state.destination).toEqual({ kind: 'new-workspace' });
    expect(state.requiresExplicitChoice).toBe(false);
  });

  it('marks a multi-FASTA file as fail-closed blocked', async () => {
    const state = await buildImportWizardState(
      ['/drop/multi.fasta'],
      ctx({
        stat: vi.fn(async () => ({ isDirectory: false, size: 50 })),
        readText: vi.fn(async () => ['>a', 'ACGT', '>b', 'TTTT'].join('\n')),
      })
    );
    expect(state.items[0].block?.kind).toBe('multi-record-fasta');
  });

  it('accepts multi-record FASTA in the typed DNA workbench', async () => {
    const state = await buildImportWizardState(
      ['/drop/multi.fasta'],
      ctx({
        initialDestinationPath: '/ws/sequences',
        importIntent: { entityType: 'dna-sequences' },
        stat: vi.fn(async () => ({ isDirectory: false, size: 50 })),
        readText: vi.fn(async () => ['>a', 'ACGT', '>b', 'TTTT'].join('\n')),
        previewSequenceImport: vi.fn(async (sourcePath: string) => ({
          kind: 'ready' as const,
          sourcePath,
          sourceSha256: 'b'.repeat(64),
          packages: [
            { name: 'a', recordIndex: 0, recordCount: 2 },
            { name: 'b', recordIndex: 1, recordCount: 2 },
          ],
        })),
      })
    );

    expect(state.items).toHaveLength(2);
    expect(state.items.every((item) => item.block === undefined)).toBe(true);
    expect(state.items.every((item) => item.target?.kind === 'existing-root')).toBe(true);
  });

  it('previews every resulting sequence package instead of the source container file', async () => {
    const previewSequenceImport = vi.fn(async (sourcePath: string) => ({
      kind: 'ready' as const,
      sourcePath,
      sourceSha256: 'c'.repeat(64),
      packages: [
        { name: 'sequence-222046-', recordIndex: 0, recordCount: 2 },
        { name: 'STRUCT_MG1655_MIOC', recordIndex: 1, recordCount: 2 },
      ],
    }));
    const context = ctx({
      forceExplicitDestination: true,
      importIntent: { entityType: 'dna-sequences' },
      previewSequenceImport,
    });

    const state = await buildImportWizardState(['/drop/two-real-records.gb'], context);

    expect(previewSequenceImport).toHaveBeenCalledWith('/drop/two-real-records.gb');
    expect(state.items).toHaveLength(2);
    expect(state.items.map((item) => item.name)).toEqual([
      'sequence-222046-',
      'STRUCT_MG1655_MIOC',
    ]);
    expect(state.items.every((item) => !item.name.includes('.gb'))).toBe(true);
    expect(state.items.map((item) => item.sourcePath)).toEqual([
      '/drop/two-real-records.gb',
      '/drop/two-real-records.gb',
    ]);
    expect(state.items.map((item) => item.expectedSourceSha256)).toEqual([
      'c'.repeat(64),
      'c'.repeat(64),
    ]);
  });

  it('merges the dedup preview onto the matching item', async () => {
    const previewDedup = vi.fn(async () => [
      {
        sourcePath: '/drop/twin.gb',
        decision: {
          action: 'skip-duplicate',
          existingRelPath: 'orig.gb',
          matchedByName: false,
        } as const,
      },
    ]);
    const state = await buildImportWizardState(
      ['/drop/twin.gb'],
      ctx({
        stat: vi.fn(async () => ({ isDirectory: false, size: 10 })),
        previewDedup,
      })
    );
    expect(previewDedup).toHaveBeenCalledWith({
      sourcePaths: ['/drop/twin.gb'],
      targetRoot: '/ws',
    });
    expect(state.items[0].dedup).toEqual({
      action: 'skip-duplicate',
      existingRelPath: 'orig.gb',
      matchedByName: false,
    });
  });

  it('does NOT read content for a large file (format from extension only, no block)', async () => {
    const readText = vi.fn(async () => 'should not be called');
    const state = await buildImportWizardState(
      ['/drop/huge.gb'],
      ctx({
        stat: vi.fn(async () => ({ isDirectory: false, size: 500 * 1024 * 1024 })),
        readText,
      })
    );
    expect(readText).not.toHaveBeenCalled();
    expect(state.items[0].format).toBe('genbank');
    expect(state.items[0].block).toBeUndefined();
  });

  it('does not run the dedup preview when the destination is a new workspace', async () => {
    const previewDedup = vi.fn(async () => []);
    await buildImportWizardState(
      ['/drop/Proj'],
      ctx({
        folders: [],
        stat: vi.fn(async () => ({ isDirectory: true, size: 0 })),
        previewDedup,
      })
    );
    expect(previewDedup).not.toHaveBeenCalled();
  });
});
