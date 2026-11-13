import { hostedWorkspaceSessionController } from '../hosted/controller';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHostedRuntimeProfile } from '../shared/runtime-profile';
import { HostedCapabilityError, hostedBrowserBridge } from './hosted';

describe('hosted browser platform', () => {
  afterEach(() => {
    delete document.documentElement.dataset.dnaforgeRuntime;
  });

  it('routes canonical catalog discovery through the active hosted snapshot without exposing native authoring', async () => {
    const workspaceId = '88888888-8888-4888-8888-888888888888';
    const root = `/hosted/${workspaceId}`;
    const original = hostedWorkspaceSessionController.getState();
    const state = vi.spyOn(hostedWorkspaceSessionController, 'getState').mockReturnValue({
      ...original,
      principal: { id: 'catalog-account', label: 'Catalog account' },
      activeWorkspaceId: workspaceId,
      snapshot: { workspaceId, revisionId: null, revisionNumber: 0, files: [] },
      workspaces: [
        {
          workspaceId,
          displayName: 'Hydrated workspace',
          latestRevisionId: null,
          latestRevisionNumber: 0,
        },
      ],
    });
    try {
      const id = await hostedBrowserBridge.db.ensureWorkspaceOwner(root, undefined, {
        name: 'Caller label',
        recordOpen: true,
      });
      expect(id).toBeGreaterThan(0);
      const notebook = await hostedBrowserBridge.db.registerCatalogEntity({
        type: 'notebook',
        name: 'Original notes',
        locator: 'entity://page/catalog-platform-notebook',
        storageType: 'database',
        workspaceRoot: root,
      });
      await expect(
        hostedBrowserBridge.db.updateCatalogEntityPresentation({
          entityId: notebook.id,
          name: 'Updated notes',
        })
      ).resolves.toMatchObject({
        id: notebook.id,
        workspace_id: id,
        name: 'Updated notes',
      });
      await expect(
        hostedBrowserBridge.db.select('SELECT id,name,repo_uuid FROM workspaces WHERE path = ?', [
          root,
        ])
      ).resolves.toEqual([{ id, name: 'Hydrated workspace', repo_uuid: workspaceId }]);
      await expect(
        hostedBrowserBridge.db.ensureWorkspaceOwner('/Users/ada/project')
      ).rejects.toThrow(/canonical hosted/);
      await expect(
        hostedBrowserBridge.db.ensureWorkspaceOwner('/hosted/77777777-7777-4777-8777-777777777777')
      ).rejects.toThrow(/active hydrated/);
      await expect(
        hostedBrowserBridge.db.ensureSequenceIndex({
          documentId: 'x',
          filePath: root + '/x.gb',
          workspaceRoot: root,
        })
      ).rejects.toBeInstanceOf(HostedCapabilityError);
      await hostedBrowserBridge.db.replacePrimerProjection({
        id: 'hosted-platform-primer',
        catalogNumber: 'P001',
        name: 'Hosted primer',
        sequence: 'ACGT',
        length: 4,
        tm: null,
        gcPercent: 50,
        origin: 'manual',
        originDetails: {},
        vendor: null,
        modifications: null,
        application: 'pcr',
        notes: null,
        workspaceId: id,
        createdAt: 1,
        updatedAt: 1,
        bindings: [],
      });
      await expect(
        hostedBrowserBridge.db.select('SELECT id,name FROM primers WHERE id = ?', [
          'hosted-platform-primer',
        ])
      ).resolves.toEqual([{ id: 'hosted-platform-primer', name: 'Hosted primer' }]);
    } finally {
      state.mockRestore();
    }
  });

  it('keeps the desktop session allowance unavailable without a desktop session', async () => {
    await expect(hostedBrowserBridge.hostedAi.readIncludedAllowance()).resolves.toEqual({
      status: 'unavailable',
      code: 'not_configured',
    });
  });

  it('identifies as the hosted production runtime, not browser-mock fixtures', () => {
    expect(createHostedRuntimeProfile()).toMatchObject({
      kind: 'hosted-browser',
      isElectron: false,
      scenarioMutationAllowed: false,
    });
    expect(hostedBrowserBridge.runtime.getProfile().kind).toBe('hosted-browser');
  });

  it('is not a thenable, so async initPlatform can return it', async () => {
    expect(hostedBrowserBridge.then).toBeUndefined();
    await expect((async () => hostedBrowserBridge)()).resolves.toBe(hostedBrowserBridge);
  });

  it('lets the application shell start and refuses desktop-only capabilities', async () => {
    await expect(hostedBrowserBridge.startup.acknowledge('hosted-browser')).resolves.toBe(true);
    await expect(hostedBrowserBridge.config.getSidecarStatus()).resolves.toBe('unavailable');
    await expect(hostedBrowserBridge.shell.revealItemInDir('/tmp')).rejects.toBeInstanceOf(
      HostedCapabilityError
    );
  });

  it('exposes a hosted workspace filesystem instead of browser-mock fixtures', () => {
    expect(typeof hostedBrowserBridge.fs.readDir).toBe('function');
    expect(typeof hostedBrowserBridge.workspace.listChildren).toBe('function');
    expect(hostedBrowserBridge.workspace.relocateEntityFile.name).toBe('relocateHostedEntityFile');
    expect(typeof hostedBrowserBridge.shell.trashItem).toBe('function');
  });

  it('leaves Electron main-process notebook helpers unset so renderer writes run', () => {
    expect(hostedBrowserBridge.fs.publishNotebookPackageV2InMain).toBeUndefined();
    expect(hostedBrowserBridge.fs.migrateNotebookPackageAtPathInMain).toBeUndefined();
  });

  it('leaves the optional native project event writer unset so the shared owner runs', () => {
    expect(hostedBrowserBridge.fs.appendProjectMemoryEvent).toBeUndefined();
  });

  it('accepts hosted file watches without crashing sequence tabs', async () => {
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const path = `/hosted/${workspaceId}/sequences/a.gbk`;
    await expect(hostedBrowserBridge.fs.watchFile(path)).resolves.toBeUndefined();
    await expect(hostedBrowserBridge.fs.unwatchFile(path)).resolves.toBeUndefined();
  });

  it('keeps LIMS empty until a real entity is registered', async () => {
    await hostedBrowserBridge.lims.resetRegistry();
    await expect(hostedBrowserBridge.lims.queryEntities()).resolves.toEqual([]);
    await hostedBrowserBridge.lims.registerEntity({
      id: 'hosted-notebook',
      kind: 'notebook',
      name: 'Lab notes',
      fields: { packagePath: '/hosted/ws/Lab notes' },
    });
    await expect(hostedBrowserBridge.lims.queryEntities({ kind: 'notebook' })).resolves.toEqual([
      expect.objectContaining({ id: 'hosted-notebook', name: 'Lab notes' }),
    ]);
  });

  it('refuses indexed genome sidecar reads instead of inventing tiles', async () => {
    await expect(hostedBrowserBridge.genome.open({} as never)).rejects.toBeInstanceOf(
      HostedCapabilityError
    );
    await expect(
      hostedBrowserBridge.genome.readAssemblyOverviewTexture({} as never)
    ).resolves.toBeNull();
  });

  it('keeps local CLI agents unavailable and routes Hosted AI through the contribution bridge', async () => {
    const started = await hostedBrowserBridge.agentSession.start({
      provider: 'codex-sdk',
      authorityProfileId: 'hosted',
      prompt: 'hello',
      cwd: null,
      workspaceGrounding: 'required',
    });
    expect(started.ok).toBe(false);
    expect(started.error).toMatch(/DNAForge AI/u);
    expect(hostedBrowserBridge).not.toHaveProperty('hostedContributionDialog');
    expect(typeof hostedBrowserBridge.agentConfirm.onRequest).toBe('function');
  });
});
