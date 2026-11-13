import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React, { act, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LoadedViewer } from './LoadedViewer';
import type { Structure3dAttrs } from '../types';
import { createDefaultStructureViewState } from '../utils/viewRecipe';

const hookMocks = vi.hoisted(() => ({
  latestMolstarProps: null as null | {
    view?: { spin?: boolean };
    onPluginReady?: (plugin: unknown) => void;
    onLoad?: () => void;
    onCameraChange?: (snapshot: string) => void;
  },
  plugin: { id: 'spin-control-plugin' },
  useResidueHighlight: vi.fn(),
  useSelectionSideChainOverlay: vi.fn(),
  useMolstarInteraction: vi.fn(),
  handleResidueSelect: vi.fn(),
  commitFraming: vi.fn(),
}));

vi.mock('../molstar/molViewSpec', async () => {
  const actual =
    await vi.importActual<typeof import('../molstar/molViewSpec')>('../molstar/molViewSpec');
  return { ...actual, commitCurrentMolViewSpecCamera: hookMocks.commitFraming };
});

vi.mock('../MolstarViewer', async () => {
  const ReactModule = await import('react');
  return {
    MolstarViewer: (props: {
      view?: { spin?: boolean };
      onPluginReady?: (plugin: unknown) => void;
      onLoad?: () => void;
      onCameraChange?: (snapshot: string) => void;
    }) => {
      hookMocks.latestMolstarProps = props;
      ReactModule.useEffect(() => {
        props.onPluginReady?.(hookMocks.plugin);
        props.onLoad?.();
      }, [props.onLoad, props.onPluginReady]);
      return ReactModule.createElement('div', { 'data-testid': 'molstar-viewer-stub' });
    },
  };
});

vi.mock('../hooks', async () => {
  const actualViewerSettings = await vi.importActual<typeof import('../hooks/useViewerSettings')>(
    '../hooks/useViewerSettings'
  );
  return {
    useSequenceData: vi.fn(() => null),
    useResidueHighlight: hookMocks.useResidueHighlight,
    useSelectionSideChainOverlay: hookMocks.useSelectionSideChainOverlay,
    useMolstarInteraction: hookMocks.useMolstarInteraction,
    useClickDetection: vi.fn(() => ({})),
    useHoveredResidueName: vi.fn(() => undefined),
    useHighlightActions: vi.fn(() => ({
      handleSaveSelection: vi.fn(),
      handleActivateHighlight: vi.fn(),
      handleDeleteHighlight: vi.fn(),
      handleRenameHighlight: vi.fn(),
    })),
    useSavedSelectionProjections: vi.fn(() => ({ groups: [], errors: [] })),
    useViewerSettings: actualViewerSettings.useViewerSettings,
    useSavedSelectionEdit: vi.fn(() => ({
      handleResidueSelect: hookMocks.handleResidueSelect,
    })),
    useFocusClick: vi.fn(() => vi.fn()),
    useSelectionActions: vi.fn(() => ({
      handleClearSelection: vi.fn(),
      handleClearUserSelection: vi.fn(),
      handleResetCamera: vi.fn(),
      handleCenterSelection: vi.fn(),
      createContextCenterHandler: vi.fn(() => vi.fn()),
    })),
  };
});

function LoadedViewerHarness({ initialAttrs }: { initialAttrs: Structure3dAttrs }) {
  const [attrs, setAttrs] = useState(initialAttrs);
  return <LoadedViewer attrs={attrs} onUpdateAttrs={setAttrs} structureId="spin-control-test" />;
}

describe('LoadedViewer spin control regression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hookMocks.latestMolstarProps = null;
  });

  it('does not persist free camera navigation over a single authored view', async () => {
    const onUpdateAttrs = vi.fn();
    render(
      <LoadedViewer
        structureId="authored-camera-test"
        attrs={{
          source: 'pdb',
          sourceId: '1ABC',
          molViewSpec: JSON.stringify({ root: { kind: 'root' }, metadata: { title: 'View' } }),
          cameraSnapshot: 'authored camera',
        }}
        onUpdateAttrs={onUpdateAttrs}
      />
    );
    await screen.findByTestId('molstar-viewer-stub');
    onUpdateAttrs.mockClear();
    act(() => hookMocks.latestMolstarProps?.onCameraChange?.('exploratory camera'));
    expect(onUpdateAttrs).not.toHaveBeenCalled();
  });

  it('authors the explicit current framing while preserving the document and retained-result bindings', async () => {
    const onUpdateAttrs = vi.fn();
    const scene = JSON.stringify({ root: { kind: 'root' }, metadata: { title: 'View' } });
    const framedScene = JSON.stringify({
      root: { kind: 'root', children: [{ kind: 'camera', params: { position: [1, 2, 3] } }] },
      metadata: { title: 'View' },
    });
    hookMocks.commitFraming.mockReturnValue({
      scene: framedScene,
      cameraSnapshot: 'new authored camera',
    });
    const binding = {
      molecularDocumentId: 'document-id',
      molecularDocumentPath: '/project/Framed.dnaforge-molecular.json',
      molecularDocumentRevision: 'c'.repeat(64),
      molecularDocumentSavedReferenceId: 'project-head',
      molViewSpecSavedReferenceId: 'retained-result',
    };
    render(
      <LoadedViewer
        structureId="explicit-framing-test"
        attrs={{ source: 'pdb', sourceId: '1ABC', molViewSpec: scene, ...binding }}
        onUpdateAttrs={onUpdateAttrs}
      />
    );
    await screen.findByTestId('molstar-viewer-stub');
    fireEvent.click(screen.getByRole('button', { name: 'Advanced settings' }));
    onUpdateAttrs.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Use current framing' }));
    expect(hookMocks.commitFraming).toHaveBeenCalledWith(hookMocks.plugin);
    expect(onUpdateAttrs).toHaveBeenCalledWith(
      expect.objectContaining({
        ...binding,
        molViewSpec: framedScene,
        cameraSnapshot: 'new authored camera',
      })
    );
  });

  it('drives the real Spin checkbox through viewer settings into MolstarViewer props', async () => {
    render(
      <LoadedViewerHarness
        initialAttrs={{
          source: 'pdb',
          sourceId: '1ABC',
          label: 'Spin control regression',
          view: createDefaultStructureViewState(),
        }}
      />
    );

    expect(await screen.findByTestId('molstar-viewer-stub')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Advanced settings' }));
    expect(screen.getByLabelText('Spin')).not.toBeChecked();
    expect(hookMocks.latestMolstarProps?.view?.spin).toBe(false);

    fireEvent.click(screen.getByLabelText('Spin'));

    await waitFor(() => expect(screen.getByLabelText('Spin')).toBeChecked());
    await waitFor(() => expect(hookMocks.latestMolstarProps?.view?.spin).toBe(true));
  });
});
