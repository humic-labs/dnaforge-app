import { describe, it, expect, vi } from 'vitest';
import { executeImportOutcome, type ImportExecDeps } from './execute-import-outcome';
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
function deps(over: Partial<ImportExecDeps> = {}): ImportExecDeps {
  return {
    importFile: vi.fn(async (r) => ({
      destPath: `${r.targetRoot}/${r.sourcePath.split('/').pop()}`,
      relPath: r.sourcePath.split('/').pop()!,
      committed: true,
    })),
    importFolder: vi.fn(async (r) => ({
      destPath: `${r.targetRoot}/x`,
      relPath: 'x',
      committed: true,
    })),
    importManaged: vi.fn(async () => ({ repoPath: '/managed/new/repo' })),
    importFileAsNewWorkspace: vi.fn(async () => ({ repoPath: '/managed/file-ws/repo' })),
    createEmptyWorkspace: vi.fn(async () => ({ rootPath: '/managed/new-ws/repo' })),
    registerImportedSequence: vi.fn(async (r) => ({
      destPath: `${r.targetRoot}/${r.sourcePath.split('/').pop()}`,
      registered: true,
      batchId: 'batch-1',
      entityIds: ['ent-1'],
    })),
    ...over,
  };
}

describe('executeImportOutcome ', () => {
  it('imports a plain file via importFile and counts it', async () => {
    const d = deps();
    const res = await executeImportOutcome(outcome(), d);
    expect(d.importFile).toHaveBeenCalledWith(
      expect.objectContaining({ targetRoot: '/ws', sourcePath: '/drop/a.gb' })
    );
    expect(res).toMatchObject({ imported: 1, skipped: 0, failed: 0 });
  });

  it('publishes a new project with its first successfully saved reviewed package', async () => {
    const publish = vi
      .fn()
      .mockRejectedValueOnce(new Error('Package could not be saved'))
      .mockResolvedValueOnce({
        workspaceRoot: '/new',
        file: { destPath: '/new/b', relPath: 'b', committed: true },
      });
    const d = deps({ importCapturedFileAsNewWorkspace: publish });
    const items = ['a.gb', 'b.gb', 'c.gb'].map((name) =>
      file(name, { packageInputPath: '/preview/' + name })
    );
    const res = await executeImportOutcome(
      outcome({ items, destination: { kind: 'new-workspace' } }),
      d
    );
    expect(d.createEmptyWorkspace).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(2);
    expect(d.importFile).toHaveBeenCalledWith({ sourcePath: '/drop/c.gb', targetRoot: '/new' });
    expect(res).toMatchObject({
      workspaceRoot: '/new',
      createdNewWorkspace: true,
      imported: 2,
      failed: 1,
    });
    const failed = await executeImportOutcome(
      outcome({ items: items.slice(0, 1), destination: { kind: 'new-workspace' } }),
      deps({ importCapturedFileAsNewWorkspace: vi.fn().mockRejectedValue(new Error('Full')) })
    );
    expect(failed).toMatchObject({ imported: 0, failed: 1, written: [] });
    expect(failed.createdNewWorkspace).toBeUndefined();
  });

  it('counts every package produced from one multi-record sequence file', async () => {
    const d = deps({
      importFile: vi.fn(async () => ({
        destPath: '/ws/record-one.plasmid',
        relPath: 'record-one.plasmid',
        committed: true,
        packageProductPaths: [
          '/ws/record-one.plasmid',
          '/ws/record-two.plasmid',
          '/ws/record-three.plasmid',
        ],
      })),
    });

    const res = await executeImportOutcome(outcome(), d);

    expect(res).toMatchObject({ imported: 3, skipped: 0, failed: 0 });
    expect(res.written).toEqual([
      { sourcePath: '/drop/a.gb', destPath: '/ws/record-one.plasmid' },
      { sourcePath: '/drop/a.gb', destPath: '/ws/record-two.plasmid' },
      { sourcePath: '/drop/a.gb', destPath: '/ws/record-three.plasmid' },
    ]);
  });

  it('does not call any writer for a skip and counts it skipped', async () => {
    const d = deps();
    const res = await executeImportOutcome(
      outcome({
        items: [
          file('twin.gb', {
            dedup: { action: 'skip-duplicate', existingRelPath: 'o.gb', matchedByName: false },
          }),
        ],
      }),
      d
    );
    expect(d.importFile).not.toHaveBeenCalled();
    expect(res).toMatchObject({
      imported: 0,
      skipped: 1,
      skipBreakdown: { duplicates: 1, validation: 0 },
    });
  });

  it('imports valid items while distinguishing blocked and duplicate skips', async () => {
    const d = deps();
    const res = await executeImportOutcome(
      outcome({
        items: [
          file('valid.gb'),
          file('blocked.dna', {
            block: { kind: 'sequence-preview-failed', message: 'The sequence could not be read.' },
          }),
          file('duplicate.gb', {
            dedup: {
              action: 'skip-duplicate',
              existingRelPath: 'existing.gb',
              matchedByName: false,
            },
          }),
        ],
      }),
      d
    );

    expect(d.importFile).toHaveBeenCalledTimes(1);
    expect(d.importFile).toHaveBeenCalledWith(
      expect.objectContaining({ sourcePath: '/drop/valid.gb' })
    );
    expect(res).toMatchObject({
      imported: 1,
      skipped: 2,
      failed: 0,
      errors: [],
      skipBreakdown: { duplicates: 1, validation: 1 },
      written: [{ sourcePath: '/drop/valid.gb', destPath: '/ws/valid.gb' }],
    });
  });

  it('routes a folder to importFolder', async () => {
    const d = deps();
    await executeImportOutcome(
      outcome({ items: [{ path: '/drop/Proj', name: 'Proj', kind: 'folder' }] }),
      d
    );
    expect(d.importFolder).toHaveBeenCalledWith(
      expect.objectContaining({ targetRoot: '/ws', sourcePath: '/drop/Proj' })
    );
  });

  it('new workspace = ONE createEmptyWorkspace, then imports every item INTO it (red-team #2)', async () => {
    const d = deps();
    const res = await executeImportOutcome(
      outcome({
        destination: { kind: 'new-workspace' },
        items: [file('a.gb'), file('b.gb'), { path: '/drop/Proj', name: 'Proj', kind: 'folder' }],
      }),
      d
    );
    expect(d.createEmptyWorkspace).toHaveBeenCalledTimes(1);
    expect(d.importFile).toHaveBeenCalledWith(
      expect.objectContaining({ targetRoot: '/managed/new-ws/repo', sourcePath: '/drop/a.gb' })
    );
    expect(d.importFolder).toHaveBeenCalledWith(
      expect.objectContaining({ targetRoot: '/managed/new-ws/repo', sourcePath: '/drop/Proj' })
    );
    expect(d.importFileAsNewWorkspace).not.toHaveBeenCalled();
    expect(res).toMatchObject({
      imported: 3,
      workspaceRoot: '/managed/new-ws/repo',
      createdNewWorkspace: true,
    });
  });

  it('new-project DNA import keeps digest-bound package registration and entity counts', async () => {
    const sourcePath = '/drop/two-records.gb';
    const expectedSourceSha256 = 'd'.repeat(64);
    const d = deps({
      registerImportedSequence: vi.fn(async (request) => ({
        destPath: `${request.targetRoot}/first/first.gb`,
        registered: true,
        batchId: 'batch-1',
        entityIds: ['entity-1', 'entity-2'],
      })),
    });

    const res = await executeImportOutcome(
      outcome({
        importIntent: { entityType: 'dna-sequences' },
        destination: { kind: 'new-workspace' },
        items: [
          file('first', {
            path: `${sourcePath}::dnaforge-sequence-record:0`,
            sourcePath,
            expectedSourceSha256,
          }),
          file('second', {
            path: `${sourcePath}::dnaforge-sequence-record:1`,
            sourcePath,
            expectedSourceSha256,
          }),
        ],
      }),
      d
    );

    expect(d.createEmptyWorkspace).toHaveBeenCalledTimes(1);
    expect(d.registerImportedSequence).toHaveBeenCalledWith({
      sourcePath,
      targetRoot: '/managed/new-ws/repo',
      dedup: undefined,
      expectedSourceSha256,
    });
    expect(d.importFileAsNewWorkspace).not.toHaveBeenCalled();
    expect(res).toMatchObject({ imported: 2, failed: 0, createdNewWorkspace: true });
  });

  it('names a lone-folder new workspace after the folder', async () => {
    const d = deps();
    const res = await executeImportOutcome(
      outcome({
        destination: { kind: 'new-workspace' },
        items: [{ path: '/drop/Laura Export', name: 'Laura Export', kind: 'folder' }],
      }),
      d
    );
    expect(d.createEmptyWorkspace).toHaveBeenCalledWith({ name: 'Laura Export' });
    expect(res.createdWorkspaceName).toBe('Laura Export');
  });

  it('Phase 0a: a per-item existing-root target overrides the batch destination', async () => {
    const d = deps();
    const res = await executeImportOutcome(
      outcome({
        destination: { kind: 'existing-root', rootPath: '/ws' },
        items: [
          file('a.gb'),
          file('b.gb', { target: { kind: 'existing-root', rootPath: '/other' } }),
        ],
      }),
      d
    );
    expect(d.importFile).toHaveBeenCalledWith(
      expect.objectContaining({ targetRoot: '/ws', sourcePath: '/drop/a.gb' })
    );
    expect(d.importFile).toHaveBeenCalledWith(
      expect.objectContaining({ targetRoot: '/other', sourcePath: '/drop/b.gb' })
    );
    expect([...(res.touchedRoots ?? [])].sort()).toEqual(['/other', '/ws']);
  });

  it('Phase 0a: mixed routing mints ONE workspace for the new-workspace items, others stay put', async () => {
    const d = deps();
    const res = await executeImportOutcome(
      outcome({
        destination: { kind: 'existing-root', rootPath: '/ws' },
        items: [
          file('stay.gb'),
          file('new1.gb', { target: { kind: 'new-workspace' } }),
          file('new2.gb', { target: { kind: 'new-workspace' } }),
        ],
      }),
      d
    );
    expect(d.createEmptyWorkspace).toHaveBeenCalledTimes(1);
    expect(d.importFile).toHaveBeenCalledWith(
      expect.objectContaining({ targetRoot: '/ws', sourcePath: '/drop/stay.gb' })
    );
    expect(d.importFile).toHaveBeenCalledWith(
      expect.objectContaining({ targetRoot: '/managed/new-ws/repo', sourcePath: '/drop/new1.gb' })
    );
    expect(d.importFile).toHaveBeenCalledWith(
      expect.objectContaining({ targetRoot: '/managed/new-ws/repo', sourcePath: '/drop/new2.gb' })
    );
    expect(res.createdNewWorkspace).toBe(true);
  });

  it('reports the target root for an existing-root import too', async () => {
    const res = await executeImportOutcome(outcome(), deps());
    expect(res.workspaceRoot).toBe('/ws');
    expect(res.createdNewWorkspace).toBeFalsy();
  });

  it('a single failing item does NOT abort the batch (partial import)', async () => {
    const d = deps({
      importFile: vi.fn(async (r) => {
        if (r.sourcePath.includes('bad')) throw new Error('disk full');
        return { destPath: 'x', relPath: 'x', committed: true };
      }),
    });
    const res = await executeImportOutcome(outcome({ items: [file('ok.gb'), file('bad.gb')] }), d);
    expect(res.imported).toBe(1);
    expect(res.failed).toBe(1);
    expect(res.errors[0].sourcePath).toBe('/drop/bad.gb');
  });

  it('registry route: routes a registry-targeted item through the COPY→REGISTER JOIN', async () => {
    const d = deps();
    const res = await executeImportOutcome(
      outcome({
        destination: { kind: 'existing-root', rootPath: '/ws' },
        items: [file('plasmid.gb', { target: { kind: 'registry' } })],
      }),
      d
    );
    expect(d.registerImportedSequence).toHaveBeenCalledWith(
      expect.objectContaining({ sourcePath: '/drop/plasmid.gb', targetRoot: '/ws' })
    );
    expect(d.importFile).not.toHaveBeenCalled();
    expect(res).toMatchObject({ imported: 1, failed: 0 });
    expect(res.written[0]).toMatchObject({ sourcePath: '/drop/plasmid.gb' });
    expect(res.touchedRoots).toContain('/ws');
  });

  it('typed DNA route uses its workspace location and never needs a Registry destination', async () => {
    const d = deps();
    const res = await executeImportOutcome(
      outcome({
        importIntent: { entityType: 'dna-sequences' },
        items: [file('sequence.gb')],
      }),
      d
    );

    expect(d.registerImportedSequence).toHaveBeenCalledWith({
      sourcePath: '/drop/sequence.gb',
      targetRoot: '/ws',
      dedup: undefined,
    });
    expect(d.importFile).not.toHaveBeenCalled();
    expect(res).toMatchObject({ imported: 1, failed: 0, workspaceRoot: '/ws' });
  });

  it('typed DNA route counts every Registry entity produced from one multi-record file', async () => {
    const d = deps({
      registerImportedSequence: vi.fn(async (r) => ({
        destPath: `${r.targetRoot}/record-one.plasmid`,
        packageProductPaths: [
          `${r.targetRoot}/record-one.plasmid`,
          `${r.targetRoot}/record-two.plasmid`,
        ],
        registered: true,
        batchId: 'batch-1',
        entityIds: ['ent-1', 'ent-2'],
      })),
    });

    const res = await executeImportOutcome(
      outcome({
        importIntent: { entityType: 'dna-sequences' },
        items: [file('multi-record.gb')],
      }),
      d
    );

    expect(res).toMatchObject({ imported: 2, failed: 0, workspaceRoot: '/ws' });
    expect(res.written.map((written) => written.destPath)).toEqual([
      '/ws/record-one.plasmid',
      '/ws/record-two.plasmid',
    ]);
  });

  it('registry route: a durable copy with registered:false is an honest partial failure', async () => {
    const d = deps({
      registerImportedSequence: vi.fn(async (r) => ({
        destPath: `${r.targetRoot}/multi.fasta`,
        registered: false,
        batchId: null,
        entityIds: [],
        reason: 'contains 3 sequences — copied but not registered',
      })),
    });
    const res = await executeImportOutcome(
      outcome({
        destination: { kind: 'existing-root', rootPath: '/ws' },
        items: [file('multi.fasta', { target: { kind: 'registry' } })],
      }),
      d
    );
    expect(res.imported).toBe(1);
    expect(res.failed).toBe(1);
    expect(res.errors[0]).toMatchObject({ sourcePath: '/drop/multi.fasta' });
    expect(res.errors[0].error).toContain('not registered');
    expect(res.written).toEqual([{ sourcePath: '/drop/multi.fasta', destPath: '/ws/multi.fasta' }]);
  });

  it('registry route: a dedup copy skip is a duplicate without an imported or failed item', async () => {
    const d = deps({
      registerImportedSequence: vi.fn(async () => ({
        destPath: '/ws/existing.gb',
        registered: false,
        batchId: null,
        entityIds: [],
        copySkipped: true,
      })),
    });
    const res = await executeImportOutcome(
      outcome({
        items: [file('duplicate.gb', { target: { kind: 'registry' } })],
      }),
      d
    );

    expect(res).toMatchObject({
      imported: 0,
      skipped: 1,
      failed: 0,
      errors: [],
      written: [],
      skipBreakdown: { duplicates: 1, validation: 0 },
    });
  });

  it('registry route: registered:false without a reason still cannot become clean success', async () => {
    const d = deps({
      registerImportedSequence: vi.fn(async (r) => ({
        destPath: `${r.targetRoot}/rejected.gb`,
        registered: false,
        batchId: null,
        entityIds: [],
      })),
    });
    const res = await executeImportOutcome(
      outcome({
        destination: { kind: 'existing-root', rootPath: '/ws' },
        items: [file('rejected.gb', { target: { kind: 'registry' } })],
      }),
      d
    );

    expect(res).toMatchObject({ imported: 1, failed: 1 });
    expect(res.errors[0].error).toContain('registry registration did not complete');
  });

  it('registry route: mints ONE workspace when there is no batch root to copy into', async () => {
    const d = deps();
    const res = await executeImportOutcome(
      outcome({
        destination: { kind: 'new-workspace' },
        items: [
          file('a.gb', { target: { kind: 'registry' } }),
          file('b.gb', { target: { kind: 'registry' } }),
        ],
      }),
      d
    );
    expect(d.createEmptyWorkspace).toHaveBeenCalledTimes(1);
    expect(res.createdNewWorkspace).toBe(true);
    expect(d.registerImportedSequence).toHaveBeenCalledTimes(2);
    for (const call of (d.registerImportedSequence as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[0].targetRoot).toBe('/managed/new-ws/repo');
    }
  });

  it('counts a writer-reported skip (dedup skip at write time) as skipped', async () => {
    const d = deps({
      importFile: vi.fn(async () => ({
        destPath: 'x',
        relPath: 'x',
        committed: false,
        skipped: true,
      })),
    });
    const res = await executeImportOutcome(
      outcome({
        items: [
          file('dup.gb', {
            dedup: { action: 'name-collision', existingRelPath: 'dup.gb' },
            dedupResolution: 'replace',
          }),
        ],
      }),
      d
    );
    expect(res).toMatchObject({
      imported: 0,
      skipped: 1,
      failed: 0,
      skipBreakdown: { duplicates: 1, validation: 0 },
    });
  });
});
