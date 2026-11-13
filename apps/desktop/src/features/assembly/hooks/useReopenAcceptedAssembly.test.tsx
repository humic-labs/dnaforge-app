/**
 * @vitest-environment jsdom
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from '../../canvas/store';
import { useDesignStore } from '../../design/store';
import { useSequenceStore } from '../../sequence/public/store';
import { registerWorkspaceEditorBlocker } from '../../../services/workspace-editor-mutation-state';
import { acceptedAssemblyVersionFromSidecar } from '../accepted-reopen';
import { useReopenAcceptedAssembly } from './useReopenAcceptedAssembly';
import {
  clearFinalizedPlasmidIdentitiesForTests,
  plasmidIdentityForDocument,
  rememberFinalizedPlasmid,
} from '../plasmid-identity';

const fsState = vi.hoisted(() => ({
  files: new Map<string, string>(),
}));

const workflowMocks = vi.hoisted(() => ({
  reopenAcceptedAssemblyWorkflow: vi.fn(),
}));

vi.mock('../../../platform', () => ({
  platform: () => ({
    fs: {
      exists: vi.fn(async (path: string) => fsState.files.has(path)),
      readTextFile: vi.fn(async (path: string) => {
        const content = fsState.files.get(path);
        if (content === undefined) throw new Error(`Missing file: ${path}`);
        return content;
      }),
    },
  }),
}));

vi.mock('../accepted-reopen-workflow', () => ({
  reopenAcceptedAssemblyWorkflow: workflowMocks.reopenAcceptedAssemblyWorkflow,
}));

describe('useReopenAcceptedAssembly', () => {
  function openSequenceTab(entityId: string): string {
    return useCanvasStore.getState().openTab('main', {
      type: 'sequence',
      entityId,
      label: 'Sequence',
      sequenceDocument: { kind: 'catalog-sequence', entityId },
    });
  }

  beforeEach(() => {
    fsState.files.clear();
    useDesignStore.setState({
      designs: {},
      activeDesignId: null,
      pendingDispatchId: null,
    });
    useSequenceStore.setState({ dirtyPaths: {} });
    useCanvasStore.setState({
      panels: {
        main: { id: 'main', tabs: [], activeTabId: null },
      },
      layout: { type: 'panel', panelId: 'main' },
      focusedPanelId: 'main',
      oversizeScanComplete: true,
    });
    clearFinalizedPlasmidIdentitiesForTests();
    workflowMocks.reopenAcceptedAssemblyWorkflow.mockReset();
    workflowMocks.reopenAcceptedAssemblyWorkflow.mockImplementation(
      async ({ selector }: { selector: { constructId?: string; locator?: string } }) => {
        const accepted = createSidecar();
        const sessionIdentity = selector.constructId
          ? plasmidIdentityForDocument(selector.constructId)
          : null;
        const metaPath =
          sessionIdentity?.metaPath ??
          selector.locator ??
          Array.from(fsState.files.keys()).find((path) => path.endsWith('/.forge/plasmid.json'));
        if (!metaPath) throw new Error('No package metadata for reopened sequence.');
        const packageRoot = metaPath.slice(0, -'/.forge/plasmid.json'.length);
        accepted.artifacts.productGenBankPath =
          sessionIdentity?.productPath ?? `${packageRoot}/pMyConstruct.gb`;
        accepted.artifacts.sidecarJsonPath = `${packageRoot}/.forge/plasmid.json`;
        const acceptedVersion = acceptedAssemblyVersionFromSidecar(accepted, {
          sidecarChecksum: 'sha256:sidecar',
        });
        const designId = useDesignStore.getState().reopenAcceptedAssemblyVersion(acceptedVersion);
        return { designId };
      }
    );
  });

  it('opens an editable assembly inside the same sequence tab', async () => {
    fsState.files.set(
      '/workspace/assemblies/final.waypoint-assembly.json',
      JSON.stringify(createSidecar())
    );
    const tabId = openSequenceTab('legacy-final-sequence');

    const { result } = renderHook(() =>
      useReopenAcceptedAssembly('legacy-final-sequence', '/workspace/assemblies/final.gb')
    );

    await waitFor(() => expect(result.current.status).toBe('available'));

    await act(async () => {
      await result.current.reopen();
    });

    const designId = useDesignStore.getState().activeDesignId;
    expect(designId).toBeTruthy();
    expect(useDesignStore.getState().designs[designId!]).toMatchObject({
      name: 'Accepted construct',
      assemblyMethod: 'gibson',
      activeAcceptedAssemblyVersionId: 'accepted-1',
    });
    expect(
      Object.values(useCanvasStore.getState().panels).flatMap((panel) => panel.tabs)
    ).toContainEqual(
      expect.objectContaining({
        id: tabId,
        type: 'sequence',
        entityId: 'legacy-final-sequence',
        assemblyEditDesignId: designId,
      })
    );
  });

  describe('plasmid package layout', () => {
    const root = '/workspace/assemblies/pMyConstruct';

    function packageDoc(): string {
      const accepted = createSidecar();
      return JSON.stringify({
        schema: 'waypoint.plasmid.v1',
        kind: 'plasmid',
        id: 'plasmid-1',
        name: 'Accepted construct',
        updatedAt: '2026-07-25T00:00:00.000Z',
        product: { file: 'pMyConstruct.gb', topology: 'circular' },
        assembly: {
          accepted: {
            ...accepted,
            artifacts: {
              ...accepted.artifacts,
              productGenBankPath: 'pMyConstruct.gb',
              sidecarJsonPath: '.forge/plasmid.json',
            },
          },
        },
      });
    }

    describe('falls back to the legacy sidecar when the package cannot answer', () => {
      const legacy = `${root}/pMyConstruct.waypoint-assembly.json`;

      it.each([
        ['unparseable JSON', '{ not json'],
        [
          'a valid package with NO assembly',
          JSON.stringify({
            schema: 'waypoint.plasmid.v1',
            kind: 'plasmid',
            id: 'plasmid-1',
            name: 'Imported',
            updatedAt: '2026-07-25T00:00:00.000Z',
            product: { file: 'pMyConstruct.gb', topology: 'circular' },
          }),
        ],
        [
          'a record naming a DIFFERENT product',
          packageDoc().replace('pMyConstruct.gb', 'other.gb'),
        ],
      ])('%s', async (_label, metaContent) => {
        fsState.files.set(`${root}/.forge/plasmid.json`, metaContent);
        fsState.files.set(legacy, JSON.stringify(createSidecar()));

        const { result } = renderHook(() =>
          useReopenAcceptedAssembly('plasmid-1', `${root}/pMyConstruct.gb`)
        );
        await waitFor(() => expect(result.current.status).toBe('available'));
        expect(result.current.sidecarPath).toBe(legacy);
      });

      it('still reports missing when NEITHER can answer', async () => {
        fsState.files.set(`${root}/.forge/plasmid.json`, '{ not json');

        const { result } = renderHook(() =>
          useReopenAcceptedAssembly('plasmid-1', `${root}/pMyConstruct.gb`)
        );
        await waitFor(() => expect(result.current.status).toBe('missing'));
      });

      it('prefers the PACKAGE when it can answer', async () => {
        fsState.files.set(`${root}/.forge/plasmid.json`, packageDoc());
        fsState.files.set(legacy, JSON.stringify(createSidecar()));

        const { result } = renderHook(() =>
          useReopenAcceptedAssembly('plasmid-1', `${root}/pMyConstruct.gb`)
        );
        await waitFor(() => expect(result.current.status).toBe('available'));
        expect(result.current.sidecarPath).toBe(`${root}/.forge/plasmid.json`);
      });
    });

    it('finds the record inside the package and reopens the draft', async () => {
      fsState.files.set(`${root}/.forge/plasmid.json`, packageDoc());
      openSequenceTab('plasmid-1');

      const { result } = renderHook(() =>
        useReopenAcceptedAssembly('plasmid-1', `${root}/pMyConstruct.gb`)
      );
      await waitFor(() => expect(result.current.status).toBe('available'));
      expect(result.current.sidecarPath).toBe(`${root}/.forge/plasmid.json`);

      await act(async () => {
        await result.current.reopen();
      });

      const designId = useDesignStore.getState().activeDesignId;
      expect(useDesignStore.getState().designs[designId!]).toMatchObject({
        name: 'Accepted construct',
        activeAcceptedAssemblyVersionId: 'accepted-1',
      });
    });

    it('refreshes edit availability when a saved assembly appears after the tab opened', async () => {
      const { result } = renderHook(() =>
        useReopenAcceptedAssembly('plasmid-1', `${root}/pMyConstruct.gb`)
      );
      await waitFor(() => expect(result.current.status).toBe('missing'));
      fsState.files.set(`${root}/.forge/plasmid.json`, packageDoc());
      act(() => {
        window.dispatchEvent(
          new CustomEvent('waypoint:workspace-files-changed', {
            detail: { path: root },
          })
        );
      });
      await waitFor(() => expect(result.current.status).toBe('available'));
      expect(result.current.sidecarPath).toBe(`${root}/.forge/plasmid.json`);
    });

    it('does not unmount a dirty sequence editor to enter assembly editing', async () => {
      fsState.files.set(`${root}/.forge/plasmid.json`, packageDoc());
      const tabId = openSequenceTab('plasmid-1');
      useSequenceStore.setState({ dirtyPaths: { 'plasmid-1': true } });
      const { result } = renderHook(() =>
        useReopenAcceptedAssembly('plasmid-1', `${root}/pMyConstruct.gb`)
      );
      await waitFor(() => expect(result.current.status).toBe('available'));
      await act(async () => {
        await result.current.reopen();
      });
      expect(result.current.error ?? '').toMatch(/save or discard/i);
      expect(workflowMocks.reopenAcceptedAssemblyWorkflow).not.toHaveBeenCalled();
      expect(useCanvasStore.getState().findTab('sequence', 'plasmid-1')?.tabId).toBe(tabId);
      expect(useCanvasStore.getState().panels.main.tabs[0].assemblyEditDesignId).toBeUndefined();
    });

    it('does not unmount an unfinished Metadata drawer to enter assembly editing', async () => {
      fsState.files.set(`${root}/.forge/plasmid.json`, packageDoc());
      openSequenceTab('plasmid-1');
      const unregister = registerWorkspaceEditorBlocker(() => ({
        entityId: 'plasmid-1',
        path: root,
        state: 'dirty',
      }));
      try {
        const { result } = renderHook(() =>
          useReopenAcceptedAssembly('plasmid-1', `${root}/pMyConstruct.gb`)
        );
        await waitFor(() => expect(result.current.status).toBe('available'));
        await act(async () => {
          await result.current.reopen();
        });
        expect(result.current.error ?? '').toMatch(/unsaved/i);
        expect(workflowMocks.reopenAcceptedAssemblyWorkflow).not.toHaveBeenCalled();
      } finally {
        unregister();
      }
    });

    it('uses the package path when a Registry sequence tab ID is not the package ID', async () => {
      fsState.files.set(`${root}/.forge/plasmid.json`, packageDoc());
      openSequenceTab('accepted-version-tab-id');

      const { result } = renderHook(() =>
        useReopenAcceptedAssembly('accepted-version-tab-id', `${root}/pMyConstruct.gb`)
      );
      await waitFor(() => expect(result.current.status).toBe('available'));

      await act(async () => {
        await result.current.reopen();
      });

      expect(result.current.error).toBeNull();
      expect(workflowMocks.reopenAcceptedAssemblyWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({ selector: { locator: `${root}/.forge/plasmid.json` } })
      );
    });

    it('resolves package-relative artifact paths against the package root', async () => {
      fsState.files.set(`${root}/.forge/plasmid.json`, packageDoc());
      openSequenceTab('plasmid-1');
      const { result } = renderHook(() =>
        useReopenAcceptedAssembly('plasmid-1', `${root}/pMyConstruct.gb`)
      );
      await waitFor(() => expect(result.current.status).toBe('available'));
      await act(async () => {
        await result.current.reopen();
      });

      const designId = useDesignStore.getState().activeDesignId!;
      const version = useDesignStore.getState().designs[designId].acceptedAssemblyVersions![0];
      expect(version.artifacts.productGenBankPath).toBe(`${root}/pMyConstruct.gb`);
    });

    it('AC5: a MOVED package still reopens, resolving against its new location', async () => {
      const moved = '/somewhere/else/Renamed';
      fsState.files.set(`${moved}/.forge/plasmid.json`, packageDoc());
      openSequenceTab('plasmid-1');

      const { result } = renderHook(() =>
        useReopenAcceptedAssembly('plasmid-1', `${moved}/pMyConstruct.gb`)
      );
      await waitFor(() => expect(result.current.status).toBe('available'));
      await act(async () => {
        await result.current.reopen();
      });

      const designId = useDesignStore.getState().activeDesignId!;
      const version = useDesignStore.getState().designs[designId].acceptedAssemblyVersions![0];
      expect(version.artifacts.productGenBankPath).toBe(`${moved}/pMyConstruct.gb`);
    });

    it('prefers the package over a legacy sibling when both exist', async () => {
      fsState.files.set(`${root}/.forge/plasmid.json`, packageDoc());
      fsState.files.set(
        `${root}/pMyConstruct.waypoint-assembly.json`,
        JSON.stringify(createSidecar())
      );

      const { result } = renderHook(() =>
        useReopenAcceptedAssembly('plasmid-1', `${root}/pMyConstruct.gb`)
      );
      await waitFor(() => expect(result.current.status).toBe('available'));
      expect(result.current.sidecarPath).toBe(`${root}/.forge/plasmid.json`);
    });

    it('reports missing when neither layout is present', async () => {
      const { result } = renderHook(() =>
        useReopenAcceptedAssembly('plasmid-1', `${root}/pMyConstruct.gb`)
      );
      await waitFor(() => expect(result.current.status).toBe('missing'));
    });

    it('uses the finalized session identity immediately and keeps the same sequence tab', async () => {
      const productPath = `${root}/pMyConstruct.gb`;
      rememberFinalizedPlasmid({
        productPath,
        packageRoot: root,
        metaPath: `${root}/.forge/plasmid.json`,
        constructId: 'plasmid-1',
        acceptedVersion: acceptedAssemblyVersionFromSidecar(createSidecar(), {
          sidecarChecksum: 'sha256:sidecar',
        }),
      });
      const tabId = useCanvasStore.getState().openTab('main', {
        type: 'sequence',
        entityId: 'plasmid-1',
        label: 'pMyConstruct',
        sequenceDocument: {
          kind: 'managed-sequence',
          packageId: 'plasmid-1',
          packageRoot: root,
        },
      });

      const { result } = renderHook(() => useReopenAcceptedAssembly('plasmid-1', productPath));
      expect(result.current.status).toBe('available');
      expect(result.current.sidecarPath).toBe(`${root}/.forge/plasmid.json`);

      await act(async () => {
        await result.current.reopen();
      });

      const designId = useDesignStore.getState().activeDesignId;
      const tabs = useCanvasStore.getState().panels.main.tabs;
      expect(tabs).toHaveLength(1);
      expect(tabs[0]).toMatchObject({
        id: tabId,
        type: 'sequence',
        entityId: 'plasmid-1',
        assemblyEditDesignId: designId,
      });
      expect(workflowMocks.reopenAcceptedAssemblyWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          requireProductIntegrity: false,
          selector: expect.objectContaining({ constructId: 'plasmid-1' }),
        })
      );
      expect(plasmidIdentityForDocument('plasmid-1')).toBeNull();
    });

    it('offers NOTHING to reopen for an imported plasmid (no build record)', async () => {
      fsState.files.set(
        `${root}/.forge/plasmid.json`,
        JSON.stringify({
          schema: 'waypoint.plasmid.v1',
          kind: 'plasmid',
          id: 'plasmid-imported',
          name: 'pUC19',
          product: { file: 'pMyConstruct.gb', topology: 'circular' },
        })
      );

      const { result } = renderHook(() =>
        useReopenAcceptedAssembly('plasmid-imported', `${root}/pMyConstruct.gb`)
      );
      await waitFor(() => expect(result.current.status).toBe('missing'));
    });

    it('offers recipe reopen and a mismatch notice when the product file drifted', async () => {
      fsState.files.set(`${root}/.forge/plasmid.json`, packageDoc());
      fsState.files.set(`${root}/pMyConstruct.gb`, 'LOCUS drifted\nORIGIN\n        1 aaaa\n//\n');
      openSequenceTab('plasmid-1');

      const { result } = renderHook(() =>
        useReopenAcceptedAssembly('plasmid-1', `${root}/pMyConstruct.gb`)
      );
      await waitFor(() => expect(result.current.status).toBe('available'));
      await waitFor(() => {
        expect(result.current.productMismatch).toEqual({
          expectedChecksum: 'sha256:gb',
          actualChecksum: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        });
      });

      await act(async () => {
        await result.current.reopen();
      });
      expect(workflowMocks.reopenAcceptedAssemblyWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({ requireProductIntegrity: false })
      );
    });

    it('offers NOTHING for a stray GenBank that is not the package product', async () => {
      fsState.files.set(`${root}/.forge/plasmid.json`, packageDoc());

      const { result } = renderHook(() =>
        useReopenAcceptedAssembly('some-other-sequence', `${root}/some-other-sequence.gb`)
      );
      await waitFor(() => expect(result.current.status).toBe('missing'));
    });
  });
});

function createSidecar() {
  return {
    type: 'accepted_assembly',
    schemaVersion: 1,
    acceptedAssemblyVersionId: 'accepted-1',
    lifecycleState: 'written',
    acceptedAt: '2026-05-17T04:00:00.000Z',
    designId: 'design-1',
    designName: 'Accepted construct',
    construction: {
      method: 'gibson',
      topology: 'circular',
      canonicalDraftChecksum: 'sha256:canonical',
      regionCount: 2,
      spacerCount: 0,
    },
    projectionInput: {
      schemaVersion: 1,
      designId: 'design-1',
      designName: 'Accepted construct',
      topology: 'circular',
      assemblyMethod: 'gibson',
      backboneSequenceId: null,
      defaultHomologyLength: 30,
      productSequence: 'ATGCGCTA',
      regions: [
        {
          id: 'left',
          sourceSequenceId: 'source-left',
          sourceSequenceName: 'Source left',
          sourceType: 'pcr',
          sourceStart: 0,
          sourceEnd: 4,
          sequence: 'ATGC',
          annotations: [],
        },
        {
          id: 'right',
          sourceSequenceId: 'source-right',
          sourceSequenceName: 'Source right',
          sourceType: 'pcr',
          sourceStart: 0,
          sourceEnd: 4,
          sequence: 'GCTA',
          annotations: [],
        },
      ],
      spacers: [],
      homologyRegions: [],
      designPrimers: [],
      sourceProvenance: [
        {
          regionId: 'left',
          sourceType: 'pcr',
          sourceSequenceId: 'source-left',
          sourceSequenceName: 'Source left',
          copiedDirection: 'forward',
          selectedSourceRange: { start: 0, end: 4 },
          includedSourceSegments: [{ start: 0, end: 4, role: 'included-template' }],
          sourceAnnotations: [],
          copiedAnnotations: [],
        },
        {
          regionId: 'right',
          sourceType: 'pcr',
          sourceSequenceId: 'source-right',
          sourceSequenceName: 'Source right',
          copiedDirection: 'forward',
          selectedSourceRange: { start: 0, end: 4 },
          includedSourceSegments: [{ start: 0, end: 4, role: 'included-template' }],
          sourceAnnotations: [],
          copiedAnnotations: [],
        },
      ],
      canonicalDraftChecksum: 'sha256:canonical',
    },
    validationSnapshot: {
      schemaVersion: 1,
      designId: 'design-1',
      designVersion: 3,
      assemblyMethod: 'gibson',
      projectionInputChecksum: 'sha256:canonical',
      validatedAt: '2026-05-17T04:00:00.000Z',
      clean: true,
      issues: [],
    },
    artifacts: {
      productGenBankPath: '/workspace/assemblies/final.gb',
      sidecarJsonPath: '/workspace/assemblies/final.waypoint-assembly.json',
      productSequenceChecksum: 'sha256:product',
      productGenBankChecksum: 'sha256:gb',
      canonicalDraftChecksum: 'sha256:canonical',
    },
  };
}
