/** @vitest-environment jsdom */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogReferenceCandidate } from '../../../db/catalog-reference-search';
import type { SequenceDesign } from '../../design/types';
import type { MocloCatalogCandidate } from '../../design/moclo-part-catalog';
import type { VirtualDigestFragment } from '../hooks/useVirtualDigest';
import { MocloSlotPartPicker, useMocloPartCatalog } from './MocloSlotPartPicker';
import { notifyWorkspaceReconciled } from '../../../services/workspace-reconciled-event';

const mocks = vi.hoisted(() => ({
  loadInventory: vi.fn(),
  loadCandidates: vi.fn(),
  kitChanged: undefined as undefined | ((root: string) => void),
}));

vi.mock('../../design/moclo-schema-catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../design/moclo-schema-catalog')>()),
  subscribeMocloSchemaCatalog: (listener: (root: string) => void) => {
    mocks.kitChanged = listener;
    return () => {
      mocks.kitChanged = undefined;
    };
  },
}));

function PickerHarness({
  projectRoot,
  open = true,
  ...props
}: {
  projectRoot: string;
  open?: boolean;
  design: SequenceDesign;
  slotIndex: number;
  onChoose: (candidate: MocloCatalogCandidate) => void;
  onClose: () => void;
}) {
  const catalog = useMocloPartCatalog(projectRoot, props.design.goldenGateSchema?.enzyme);
  return open ? <MocloSlotPartPicker {...props} catalog={catalog} /> : null;
}

vi.mock('../../design/moclo-kit-definition', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../design/moclo-kit-definition')>()),
  loadMocloKitDefinitionInventory: mocks.loadInventory,
}));

vi.mock('../../design/moclo-part-catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../design/moclo-part-catalog')>()),
  loadMocloCatalogCandidates: mocks.loadCandidates,
}));

describe('MocloSlotPartPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadInventory.mockResolvedValue({ definitions: [], issues: [] });
    mocks.loadCandidates.mockResolvedValue({
      candidates: [candidate('matching', 'Matching promoter', 'TACT', 'TACT')],
      skippedSourceCount: 0,
    });
  });

  it('arrows through results while retaining search focus and selects with Enter', async () => {
    mocks.loadCandidates.mockResolvedValue({
      candidates: [
        candidate('alpha', 'Alpha', 'TACT', 'TACT'),
        candidate('beta', 'Beta', 'TACT', 'TACT'),
        candidate('gamma', 'Gamma', 'TACT', 'TACT'),
      ],
      skippedSourceCount: 0,
    });
    const onChoose = vi.fn();
    const onClose = vi.fn();
    render(
      <PickerHarness
        design={schemaDesign()}
        projectRoot="/project-b"
        slotIndex={0}
        onChoose={onChoose}
        onClose={onClose}
      />
    );
    const alpha = await screen.findByTestId('moclo-candidate-alpha');
    const beta = screen.getByTestId('moclo-candidate-beta');
    const input = screen.getByRole('searchbox');
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(alpha).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', alpha.id);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(beta).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(alpha).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({ id: 'beta' }));
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clears keyboard highlight when filtering and never selects an absent result', async () => {
    mocks.loadCandidates.mockResolvedValue({
      candidates: [
        candidate('alpha', 'Alpha', 'TACT', 'TACT'),
        candidate('beta', 'Beta', 'TACT', 'TACT'),
      ],
      skippedSourceCount: 0,
    });
    const onChoose = vi.fn();
    render(
      <PickerHarness
        design={schemaDesign()}
        projectRoot="/project-b"
        slotIndex={0}
        onChoose={onChoose}
        onClose={vi.fn()}
      />
    );
    await screen.findByTestId('moclo-candidate-alpha');
    const input = screen.getByRole('searchbox');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.change(input, { target: { value: 'Beta' } });
    expect(input).not.toHaveAttribute('aria-activedescendant');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByTestId('moclo-candidate-beta')).toHaveAttribute('aria-selected', 'true');
    fireEvent.change(input, { target: { value: 'no matches' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChoose).not.toHaveBeenCalled();
    expect(input).not.toHaveAttribute('aria-activedescendant');
  });

  it('shows the component label with its package name and searches that same label', async () => {
    const part = {
      ...candidate('described', 'pYTK051', 'TACT', 'TACT'),
      componentLabel: { text: 'ScENO1 Terminator', source: 'annotation' as const },
    };
    mocks.loadCandidates.mockResolvedValue({ candidates: [part], skippedSourceCount: 0 });
    const onChoose = vi.fn();
    render(
      <PickerHarness
        design={schemaDesign()}
        projectRoot="/project-b"
        slotIndex={0}
        onChoose={onChoose}
        onClose={vi.fn()}
      />
    );
    const row = await screen.findByRole('option', { name: /ScENO1 Terminator.*pYTK051/ });
    expect(row.querySelector('.font-semibold')?.textContent).toBe('ScENO1 Terminator');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'ENO1' } });
    fireEvent.click(screen.getByRole('option', { name: /ScENO1 Terminator.*pYTK051/ }));
    expect(onChoose).toHaveBeenCalledWith(expect.objectContaining(part));
  });

  it('refreshes member metadata after an agent kit save in the owning project', async () => {
    render(
      <PickerHarness
        design={schemaDesign()}
        projectRoot="/project-b"
        slotIndex={0}
        onChoose={vi.fn()}
        onClose={vi.fn()}
      />
    );
    await screen.findByRole('option', { name: /Matching promoter/ });
    await act(() => mocks.kitChanged?.('/project-a'));
    expect(mocks.loadCandidates).toHaveBeenCalledTimes(1);
    mocks.loadCandidates.mockResolvedValue({
      candidates: [candidate('new', 'Newly registered promoter', 'TACT', 'TACT')],
      skippedSourceCount: 0,
    });
    await act(() => mocks.kitChanged?.('/project-b'));
    await screen.findByRole('option', { name: /Newly registered promoter/ });
    expect(screen.queryByRole('option', { name: /Matching promoter/ })).toBeNull();
  });

  it('does not reload the project when only the schema object changes', async () => {
    const design = schemaDesign();
    const props = { projectRoot: '/project-b', slotIndex: 0, onChoose: vi.fn(), onClose: vi.fn() };
    const view = render(<PickerHarness {...props} design={design} />);
    await screen.findByRole('option', { name: /Matching promoter/ });
    view.rerender(
      <PickerHarness
        {...props}
        design={{ ...design, goldenGateSchema: { ...design.goldenGateSchema! } }}
      />
    );
    await screen.findByRole('option', { name: /Matching promoter/ });
    expect(mocks.loadCandidates).toHaveBeenCalledTimes(1);
  });

  it('refreshes only when its owning project changes', async () => {
    render(
      <PickerHarness
        design={schemaDesign()}
        projectRoot="/project-b"
        slotIndex={0}
        onChoose={vi.fn()}
        onClose={vi.fn()}
      />
    );
    await screen.findByRole('option', { name: /Matching promoter/ });
    await act(() => notifyWorkspaceReconciled('/project-a'));
    expect(mocks.loadCandidates).toHaveBeenCalledTimes(1);
    mocks.loadCandidates.mockResolvedValue({
      candidates: [candidate('new', 'New promoter', 'TACT', 'TACT')],
      skippedSourceCount: 0,
    });
    await act(() => notifyWorkspaceReconciled('/project-b'));
    await waitFor(() =>
      expect(screen.queryByRole('option', { name: /New promoter/ })).not.toBeNull()
    );
    expect(screen.queryByRole('option', { name: /Matching promoter/ })).toBeNull();
  });

  it('loads candidates from the exact project and returns the selected digest fragment', async () => {
    const design = schemaDesign();
    const onChoose = vi.fn();
    render(
      <PickerHarness
        design={design}
        projectRoot="/project-b"
        slotIndex={0}
        onChoose={onChoose}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(await screen.findByRole('option', { name: /Matching promoter/ }));

    expect(mocks.loadCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceRoot: '/project-b', enzymeName: 'BsaI' })
    );
    expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({ id: 'matching' }));
  });

  it('shows names and ends without turning inconsistent metadata into categories or warnings', async () => {
    const crossKit = {
      ...candidate('other', 'Other-kit part', 'TACT', 'TACT'),
      kit: { id: 'other-kit', name: 'Other kit' },
      roleEvidence: [{ label: 'Level 0/2 Ampicillin', source: 'Imported subtype' }],
    };
    const unknown = {
      ...candidate('unknown', 'Unclassified part', 'TACT', 'TACT'),
      roleEvidence: [],
    };
    mocks.loadCandidates.mockResolvedValue({
      candidates: [crossKit, unknown],
      skippedSourceCount: 0,
    });
    const onChoose = vi.fn();
    render(
      <PickerHarness
        design={schemaDesign()}
        projectRoot="/project-b"
        slotIndex={0}
        onChoose={onChoose}
        onClose={vi.fn()}
      />
    );
    await screen.findByRole('option', { name: /Other-kit part/ });
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(
      screen.queryByText(/Different part type|Part type unknown|Level 0\/2 Ampicillin/)
    ).toBeNull();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Other kit' } });
    expect(screen.queryByRole('option', { name: /Unclassified part/ })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: /Other-kit part/ }));
    expect(onChoose).toHaveBeenCalledWith(expect.objectContaining(crossKit));
  });

  it('preloads once and retains the catalog when the popup is dismissed and reopened', async () => {
    const props = {
      design: schemaDesign(),
      projectRoot: '/project-b',
      slotIndex: 0,
      onChoose: vi.fn(),
      onClose: vi.fn(),
    };
    const view = render(<PickerHarness {...props} open={false} />);
    await waitFor(() => expect(mocks.loadCandidates).toHaveBeenCalledTimes(1));
    view.rerender(<PickerHarness {...props} />);
    expect(screen.getByRole('option', { name: /Matching promoter/ })).toBeInTheDocument();
    view.rerender(<PickerHarness {...props} open={false} />);
    view.rerender(<PickerHarness {...props} />);
    expect(screen.getByRole('option', { name: /Matching promoter/ })).toBeInTheDocument();
    expect(mocks.loadCandidates).toHaveBeenCalledTimes(1);
  });

  it('clears old choices immediately when switching project or enzyme, and ignores late results', async () => {
    const design = schemaDesign();
    const props = {
      design,
      projectRoot: '/project-b',
      slotIndex: 0,
      onChoose: vi.fn(),
      onClose: vi.fn(),
    };
    const view = render(<PickerHarness {...props} />);
    await screen.findByRole('option', { name: /Matching promoter/ });
    let finishOldProject!: (result: {
      candidates: MocloCatalogCandidate[];
      skippedSourceCount: number;
    }) => void;
    mocks.loadCandidates.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOldProject = resolve;
        })
    );
    view.rerender(<PickerHarness {...props} projectRoot="/project-c" />);
    expect(screen.queryByRole('option', { name: /Matching promoter/ })).toBeNull();
    await waitFor(() => expect(mocks.loadCandidates).toHaveBeenCalledTimes(2));
    mocks.loadCandidates.mockResolvedValue({
      candidates: [candidate('new', 'New promoter', 'TACT', 'TACT')],
      skippedSourceCount: 0,
    });
    view.rerender(
      <PickerHarness
        {...props}
        projectRoot="/project-c"
        design={{ ...design, goldenGateSchema: { ...design.goldenGateSchema!, enzyme: 'BsmBI' } }}
      />
    );
    await screen.findByRole('option', { name: /New promoter/ });
    await act(async () =>
      finishOldProject({
        candidates: [candidate('old', 'Wrong old project', 'TACT', 'TACT')],
        skippedSourceCount: 0,
      })
    );
    expect(screen.queryByRole('option', { name: /Wrong old project/ })).toBeNull();
    expect(screen.getByRole('option', { name: /New promoter/ })).toBeInTheDocument();
  });
});

function schemaDesign(): SequenceDesign {
  const now = new Date('2026-09-07T00:00:00.000Z');
  return {
    id: 'design',
    name: 'Schema assembly',
    topology: 'circular',
    regions: [
      {
        id: 'slot-promoter',
        schemaSlotId: 'promoter',
        sourceSequenceId: 'placeholder',
        sourceSequenceName: 'Empty Promoter',
        sourceStart: 0,
        sourceEnd: 0,
        sequence: '',
        annotations: [],
        isPlaceholder: true,
      },
    ],
    spacers: [],
    version: 1,
    assemblyState: 'drafting',
    validationErrors: [],
    proposedPlans: [],
    status: 'draft',
    assemblyMethod: 'goldengate',
    defaultHomologyLength: 30,
    homologyRegions: [],
    goldenGateConfig: { enzyme: 'BsaI' },
    goldenGateJunctions: [],
    goldenGateSchema: {
      id: 'schema',
      name: 'Schema',
      revision: 1,
      origin: { type: 'custom' },
      enzyme: 'BsaI',
      slots: [
        {
          id: 'promoter',
          label: 'Promoter',
          outgoingOverhang: 'TACT',
          preferredRoles: [{ label: 'promoter' }],
        },
      ],
    },
    designPrimers: [],
    selectedJunctionIndex: null,
    scrollToPosition: null,
    highlightRange: null,
    createdAt: now,
    updatedAt: now,
  };
}

function candidate(
  id: string,
  name: string,
  upstreamOverhang: string,
  downstreamOverhang: string
): MocloCatalogCandidate {
  const fragment: VirtualDigestFragment = {
    index: 0,
    startPosition: 10,
    endPosition: 110,
    length: 100,
    upstream: {
      sequence: upstreamOverhang,
      enzymeName: 'BsaI',
      enzymeNames: ['BsaI'],
      sitePosition: 3,
      siteOrientation: 'forward',
    },
    downstream: {
      sequence: downstreamOverhang,
      enzymeName: 'BsaI',
      enzymeNames: ['BsaI'],
      sitePosition: 110,
      siteOrientation: 'reverse',
    },
    ggType: 'insert',
    wrapsOrigin: false,
    annotations: [],
    internalSites: [],
    hasInternalSites: false,
  };
  const source: CatalogReferenceCandidate = {
    entityId: `entity:${id}`,
    name,
    absolutePath: `/project-b/sequences/${id}/contents/${id}.gb`,
    workspaceRelativePath: `sequences/${id}/contents/${id}.gb`,
    contentHash: `sha256:${id}`,
    objectUuid: `object:${id}`,
    sizeBytes: 200,
    sequenceDocument: { kind: 'catalog-sequence', entityId: `entity:${id}` },
  };
  return {
    id,
    name,
    route: 'restriction-digest',
    upstreamOverhang,
    downstreamOverhang,
    roleEvidence: [{ label: 'promoter', source: 'test fixture' }],
    kit: null,
    source,
    fragment,
    digestFragments: [fragment],
    sourceSequence: 'A'.repeat(200),
    sourceAnnotations: [],
    sourceIsCircular: true,
    kitMemberId: null,
    kitPartTypeId: null,
  };
}
