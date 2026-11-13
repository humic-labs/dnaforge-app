import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SequenceDocumentRef } from '../../../shared/managed-sequence-document';

const sourceOpen = vi.hoisted(() => ({ resolve: vi.fn(), open: vi.fn() }));
vi.mock('../../sequence/sequence-document-repository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sequence/sequence-document-repository')>()),
  resolveSequenceDocumentById: sourceOpen.resolve,
}));
vi.mock('../../document-opening/open-document', () => ({ openDocument: sourceOpen.open }));
import { useDesignStore } from '../../design/store';
import { useCanvasStore } from '../../canvas/store';
import { useSequenceStore } from '../../sequence/store';
import type { DesignRegion, SequenceDesign } from '../../design/types';
import { AssemblyPartsSection } from './AssemblyPartsSection';

function part(id: string, length: number, overrides: Partial<DesignRegion> = {}): DesignRegion {
  return {
    id,
    sourceSequenceId: `catalog-sequence:${id}`,
    sourceSequenceName: `${id} source`,
    sourceStart: 0,
    sourceEnd: length,
    sequence: 'A'.repeat(length),
    annotations: [],
    sourceType: 'pcr',
    ...overrides,
  };
}

function makeDesign(regions: DesignRegion[]): SequenceDesign {
  const now = new Date('2026-05-10T00:00:00.000Z');
  return {
    id: 'part-controls-design',
    name: 'Part controls',
    topology: 'linear',
    regions,
    spacers: [],
    version: 1,
    assemblyState: 'drafting',
    validationErrors: [],
    proposedPlans: [],
    status: 'draft',
    assemblyMethod: 'gibson',
    backboneSequenceId: null,
    defaultHomologyLength: 30,
    homologyRegions: [],
    designPrimers: [],
    selectedJunctionIndex: null,
    scrollToPosition: null,
    highlightRange: null,
    createdAt: now,
    updatedAt: now,
  };
}

function mount(regions: DesignRegion[]) {
  const d = makeDesign(regions);
  useDesignStore.setState({ designs: { [d.id]: d }, activeDesignId: d.id });
  render(<AssemblyPartsSection design={d} />);
  return d;
}

beforeEach(() => {
  sourceOpen.resolve.mockReset().mockImplementation(async (documentId: string) => ({
    documentId,
    ref: { kind: 'managed-sequence', packageId: documentId, packageRoot: '/project/source' },
  }));
  sourceOpen.open
    .mockReset()
    .mockImplementation(async (request: { target: { document: SequenceDocumentRef } }) => {
      const sequenceDocument = request.target.document;
      if (sequenceDocument.kind !== 'managed-sequence')
        throw new Error('Expected a managed source');
      const tabId = useCanvasStore.getState().openTab('main', {
        type: 'sequence',
        entityId: sequenceDocument.packageId,
        label: 'a source',
        sequenceDocument,
      });
      return { status: 'presented', tabId, panelId: 'main' };
    });
  useDesignStore.setState({
    designs: {},
    activeDesignId: null,
    pendingDispatchId: null,
  });
  useCanvasStore.setState({
    panels: { main: { id: 'main', tabs: [], activeTabId: null } },
    layout: { type: 'panel', panelId: 'main' },
    focusedPanelId: 'main',
    oversizeScanComplete: true,
  });
  useSequenceStore.getState().clearAll();
});

describe('crosshair — highlight the part in this assembly', () => {
  it('points the assembly viewer at the part where it actually sits in the product', () => {
    const d = mount([part('a', 100), part('b', 250)]);

    fireEvent.click(screen.getByTestId('assembly-part-locate-b'));

    const after = useDesignStore.getState().designs[d.id];
    expect(after.highlightRange).toEqual({ start: 100, end: 349, wraps: false });
    expect(after.scrollToPosition).toBe(101);
  });

  it('covers the part exactly, never one base more', () => {
    const d = mount([part('a', 100), part('b', 250)]);
    fireEvent.click(screen.getByTestId('assembly-part-locate-a'));
    const hr = useDesignStore.getState().designs[d.id].highlightRange!;
    expect(hr.end - hr.start + 1).toBe(100);
  });

  it('does not navigate away — it highlights in place, opening no tab', () => {
    mount([part('a', 100)]);
    fireEvent.click(screen.getByTestId('assembly-part-locate-a'));
    expect(useCanvasStore.getState().panels.main.tabs).toHaveLength(0);
  });

  it('is offered for every part that occupies a span', () => {
    mount([part('a', 100), part('b', 250), part('c', 40)]);
    for (const id of ['a', 'b', 'c']) {
      expect(screen.getByTestId(`assembly-part-locate-${id}`)).toBeTruthy();
    }
  });
});

describe('open-external — open the source at this part', () => {
  it('opens the source file and highlights the part provenance span there', async () => {
    mount([part('a', 100, { sourceStart: 40, sourceEnd: 140 })]);

    fireEvent.click(screen.getByTestId('assembly-part-open-source-a'));

    await waitFor(() =>
      expect(useCanvasStore.getState().findTab('sequence', 'catalog-sequence:a')).not.toBeNull()
    );
    const location = useCanvasStore.getState().findTab('sequence', 'catalog-sequence:a');
    expect(location).not.toBeNull();
    const tab = useCanvasStore
      .getState()
      .panels[location!.panelId].tabs.find((t) => t.id === location!.tabId);
    expect(tab?.viewState?.sequenceRendererVisibility).toBe('map');
    expect(tab?.viewState?.highlightRange).toEqual({ start: 40, end: 139 });
  });

  it('preserves the layout of a source tab the user already opened', () => {
    mount([part('a', 100, { sourceStart: 40, sourceEnd: 140 })]);
    const tabId = useCanvasStore.getState().openTab('main', {
      type: 'sequence',
      entityId: 'catalog-sequence:a',
      label: 'a source',
      sequenceDocument: {
        kind: 'managed-sequence',
        packageId: 'catalog-sequence:a',
        packageRoot: '/project/source',
      },
      viewState: { sequenceRendererVisibility: 'both' },
    });

    fireEvent.click(screen.getByTestId('assembly-part-open-source-a'));

    const tab = useCanvasStore
      .getState()
      .panels.main.tabs.find((candidate) => candidate.id === tabId);
    expect(tab?.viewState?.sequenceRendererVisibility).toBe('both');
    expect(tab?.viewState?.highlightRange).toEqual({ start: 40, end: 139 });
  });

  it('is the same action the part name already performs', async () => {
    mount([part('a', 100, { sourceStart: 40, sourceEnd: 140 })]);
    fireEvent.click(screen.getByTestId('assembly-part-source-link-a'));
    await waitFor(() =>
      expect(useCanvasStore.getState().findTab('sequence', 'catalog-sequence:a')).not.toBeNull()
    );
    const viaName = useCanvasStore.getState().findTab('sequence', 'catalog-sequence:a');
    expect(viaName).not.toBeNull();
  });
});

describe('a pasted sequence has no source to open', () => {
  const pasted = part('p', 60, {
    sourceSequenceId: 'external',
    sourceSequenceName: 'Pasted sequence',
  });

  it('offers no source link and no open-external control', () => {
    mount([pasted]);
    expect(screen.queryByTestId('assembly-part-source-link-p')).toBeNull();
    expect(screen.queryByTestId('assembly-part-open-source-p')).toBeNull();
  });

  it('still shows the part name as plain text', () => {
    mount([pasted]);
    expect(screen.getByText(/Pasted sequence/)).toBeTruthy();
  });

  it('KEEPS its Clear action — Clear drops the sequence, it does not open anything', () => {
    mount([pasted]);
    expect(screen.getByTestId('assembly-clear-part-p')).toBeTruthy();
  });

  it('still offers the crosshair — it IS in the product, it just has no source', () => {
    const d = mount([pasted]);
    fireEvent.click(screen.getByTestId('assembly-part-locate-p'));
    expect(useDesignStore.getState().designs[d.id].highlightRange).toEqual({
      start: 0,
      end: 59,
      wraps: false,
    });
  });
});

describe('a digest fragment keeps its Clear action too', () => {
  const fragment = part('f', 80, {
    sourceSequenceId: 'pUC19',
    sourceSequenceName: 'pUC19 fragment',
    sourceType: 'rd',
  });

  it('offers both Clear and the source-document link', () => {
    mount([fragment]);
    expect(screen.getByTestId('assembly-clear-part-f')).toBeTruthy();
    expect(screen.getByTestId('assembly-part-source-link-f')).toBeTruthy();
    expect(screen.getByTestId('assembly-part-open-source-f')).toBeTruthy();
  });

  it('actually clears when clicked', () => {
    const d = mount([fragment]);
    fireEvent.click(screen.getByTestId('assembly-clear-part-f'));
    const region = useDesignStore.getState().designs[d.id].regions[0];
    expect(region.isPlaceholder).toBe(true);
  });
});

describe('an ordinary file-backed part keeps everything', () => {
  it('offers Clear, the source link, and both icons', () => {
    mount([part('ok', 50)]);
    expect(screen.getByTestId('assembly-clear-part-ok')).toBeTruthy();
    expect(screen.getByTestId('assembly-part-source-link-ok')).toBeTruthy();
    expect(screen.getByTestId('assembly-part-open-source-ok')).toBeTruthy();
    expect(screen.getByTestId('assembly-part-locate-ok')).toBeTruthy();
  });
});
