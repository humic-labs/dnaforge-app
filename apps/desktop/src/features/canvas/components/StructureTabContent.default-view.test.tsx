// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import type { Tab } from '../types';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  updateTab: vi.fn(),
}));

vi.mock('../store', () => ({
  useCanvasStore: { getState: () => ({ updateTab: mocks.updateTab }) },
}));
vi.mock('./load-states', () => ({ LoadingTab: () => <div data-testid="loading" /> }));
vi.mock('../../compute/public/prediction-result-view', () => ({
  usePredictionResultAttrs: () => undefined,
}));
vi.mock('../../page/public/embeds/structure3d/hooks/useSavedMolecularViewAttrs', () => ({
  useSavedMolecularViewAttrs: () => undefined,
}));
vi.mock('../../page/public/embeds/structure3d/store', () => ({
  useStructure3dStore: (select: (state: unknown) => unknown) =>
    select({ expandedStructures: {}, viewerInstances: {} }),
}));
vi.mock('../../page/public/embeds/structure3d/components/LazyStructure3dPanel', () => ({
  LazyStructure3dPanel: () => <div data-testid="structure-panel" />,
}));
vi.mock('../../page/public/embeds/protein-prompt-history/RunVersionSwitcher', () => ({
  ProteinRunVersionSwitcher: () => null,
}));
vi.mock('../../page/public/embeds/protein-prompt-history/ProteinRunStructureSwitcher', () => ({
  ProteinRunStructureSwitcher: () => null,
}));
vi.mock('../../structure-drawer/public/state/structure-view-handoff', () => ({
  acknowledgeStructureViewHandoff: vi.fn(),
  failStructureViewHandoff: vi.fn(),
  markStructureViewHostInteractive: vi.fn(),
  markStructureViewHostReleased: vi.fn(),
}));
vi.mock('../../molecular-documents/public/services', () => ({
  readMolecularDocument: mocks.read,
  readMolecularDocumentFollowingRename: mocks.read,
}));

import { StructureTabContent } from './StructureTabContent';
import { buildDefaultMolecularDocument } from '../../../shared/default-molecular-view';
import { molecularViewAttrs } from '../../page/public/embeds/structure3d/molecularView';
import { getCurrentMolecularSnapshot } from '../../../shared/molecular-document';

const PATH = '/project/1ABC.dnaforge-molecular.json';

async function defaultDocument() {
  return buildDefaultMolecularDocument({
    name: '1ABC',
    format: 'pdb',
    text: 'HEADER    TEST PROTEIN\nATOM      1  CA  ALA A   1\nEND\n',
    createdAt: 1_000,
    documentId: '11111111-1111-4111-8111-111111111111',
    referenceId: '22222222-2222-4222-8222-222222222222',
  });
}

function structureTab(initialStructureAttrs: Tab['initialStructureAttrs']): Tab {
  return {
    id: 'tab-1',
    type: 'structure',
    entityId: 'molecular-document:1ABC',
    label: '1ABC',
    initialStructureAttrs,
  } as Tab;
}

beforeEach(() => {
  mocks.read.mockReset();
  mocks.updateTab.mockReset();
});

describe('structure tabs bound to a default-view package ', () => {
  it('shows a loaded default view without reading its file again', async () => {
    const document = await defaultDocument();
    const attrs = {
      ...molecularViewAttrs(
        'molecular-document:1ABC',
        getCurrentMolecularSnapshot(document),
        undefined,
        document.currentReferenceId
      ),
      label: '1ABC',
      molecularDocumentId: document.id,
      molecularDocumentPath: PATH,
      molecularDocumentRevision: 'r1',
      molecularDocumentSavedReferenceId: document.currentReferenceId,
    };
    mocks.read.mockResolvedValue({
      path: PATH,
      workspaceRoot: '/project',
      revision: 'r1',
      document,
    });
    const rendered = render(
      <StructureTabContent tab={structureTab(attrs)} panelId="panel" isActive />
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(rendered.getByTestId('structure-panel')).toBeTruthy();
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it('still restores a persisted pointer tab from its file once', async () => {
    const document = await defaultDocument();
    mocks.read.mockResolvedValue({
      path: PATH,
      workspaceRoot: '/project',
      revision: 'r1',
      document,
    });
    let tab = structureTab({
      source: 'file',
      sourceId: '',
      label: '1ABC',
      molecularDocumentId: document.id,
      molecularDocumentPath: PATH,
      molecularDocumentRevision: 'r1',
      molecularDocumentSavedReferenceId: document.currentReferenceId,
    });
    mocks.updateTab.mockImplementation((_panel: string, _id: string, updates: Partial<Tab>) => {
      tab = { ...tab, ...updates };
      rendered.rerender(<StructureTabContent tab={tab} panelId="panel" isActive />);
    });
    const rendered = render(<StructureTabContent tab={tab} panelId="panel" isActive />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(rendered.getByTestId('structure-panel')).toBeTruthy();
  });

  it('restores the saved selections of a persisted pointer tab', async () => {
    const document = {
      ...(await defaultDocument()),
      selections: [{ id: 'selection-1', currentRevisionId: 'revision-1' }],
    };
    mocks.read.mockResolvedValue({
      path: PATH,
      workspaceRoot: '/project',
      revision: 'r1',
      document,
    });
    render(
      <StructureTabContent
        tab={structureTab({
          source: 'file',
          sourceId: '',
          label: '1ABC',
          molecularDocumentId: document.id,
          molecularDocumentPath: PATH,
          molecularDocumentRevision: 'r1',
          molecularDocumentSavedReferenceId: document.currentReferenceId,
        })}
        panelId="panel"
        isActive
      />
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(mocks.updateTab).toHaveBeenCalledWith(
      'panel',
      'tab-1',
      expect.objectContaining({
        initialStructureAttrs: expect.objectContaining({
          savedSelectionRefs: [
            {
              selectionId: 'selection-1',
              revisionId: 'revision-1',
              artifactPath: '1ABC.dnaforge-molecular.json',
              visible: true,
            },
          ],
        }),
      })
    );
  });
});
