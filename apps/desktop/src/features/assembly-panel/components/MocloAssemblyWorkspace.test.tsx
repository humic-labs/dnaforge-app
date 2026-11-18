/**
 * @vitest-environment jsdom
 */

import { userMessage } from '@waypoint/user-messages';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import YTK_DEFINITION_RAW from '../../../../resources/sample-workspaces/standard-samples/workspace/.forge/moclo-kits/ytk.json?raw';
import {
  CIDAR_MOCLO_RED_TU_DESIGN_ID,
  YTK_MOCLO_FACTORY_DESIGN_ID,
  cidarMocloRedFluorescentTu,
  ytkMocloFactoryExpressionCassette,
} from '../../../test/scenarios/assembly-real-pipeline';
import type { CatalogReferenceCandidate } from '../../../db/catalog-reference-search';
import type { VirtualDigestFragment } from '../hooks/useVirtualDigest';
import type {
  LoadMocloCatalogCandidatesInput,
  LoadMocloCatalogCandidatesResult,
  MocloCatalogCandidate,
} from '../../design/moclo-part-catalog';
import { parseMocloKitDefinition } from '../../design/moclo-kit-definition';
import { normalizeAssemblySlots } from '../../design/assembly-slots';
import { createMocloWorkspaceModel, type MocloWorkspaceModel } from '../moclo-workspace-model';
import { MocloAssemblyWorkspace } from './MocloAssemblyWorkspace';

const { mockLoadCatalog, mockLoadKitInventory } = vi.hoisted(() => ({
  mockLoadCatalog: vi.fn(),
  mockLoadKitInventory: vi.fn(),
}));

vi.mock('../../design/moclo-part-catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../design/moclo-part-catalog')>();
  return { ...actual, loadMocloCatalogCandidates: mockLoadCatalog };
});

vi.mock('../../design/moclo-schema-catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../design/moclo-schema-catalog')>();
  return { ...actual, loadMocloSchemaCatalog: mockLoadKitInventory };
});

const YTK_DEFINITION = parseMocloKitDefinition(YTK_DEFINITION_RAW, 'ytk.json');

function cidarModel() {
  const scenario = cidarMocloRedFluorescentTu();
  const design = scenario.designs?.designs[CIDAR_MOCLO_RED_TU_DESIGN_ID];
  if (!design) throw new Error('CIDAR fixture design is unavailable.');
  const model = createMocloWorkspaceModel(normalizeAssemblySlots(design), 'tailwind');
  if (!model) throw new Error('CIDAR fixture did not project a MoClo workspace.');
  return model;
}

function editableCidarModel(): MocloWorkspaceModel {
  const model = cidarModel();
  return {
    ...model,
    schema: {
      ...model.schema,
      origin: { type: 'custom' },
    },
  };
}

function ytkModel() {
  const scenario = ytkMocloFactoryExpressionCassette();
  const design = scenario.designs?.designs[YTK_MOCLO_FACTORY_DESIGN_ID];
  if (!design) throw new Error('YTK factory fixture design is unavailable.');
  const model = createMocloWorkspaceModel(normalizeAssemblySlots(design), 'tailwind');
  if (!model) throw new Error('YTK factory fixture did not project a MoClo workspace.');
  return model;
}

function fragment(upstream: string, downstream: string): VirtualDigestFragment {
  return {
    index: 0,
    startPosition: 10,
    endPosition: 390,
    length: 380,
    upstream: {
      sequence: upstream,
      enzymeName: 'BsaI',
      enzymeNames: ['BsaI'],
      sitePosition: 3,
      siteOrientation: 'forward',
    },
    downstream: {
      sequence: downstream,
      enzymeName: 'BsaI',
      enzymeNames: ['BsaI'],
      sitePosition: 390,
      siteOrientation: 'reverse',
    },
    ggType: 'insert',
    wrapsOrigin: false,
    annotations: [],
    internalSites: [],
    hasInternalSites: false,
  };
}

function catalogCandidate(input: {
  id: string;
  name: string;
  role: string;
  kitId: string;
  kitName: string;
  upstream: string;
  downstream: string;
}): MocloCatalogCandidate {
  const digestFragment = fragment(input.upstream, input.downstream);
  const source: CatalogReferenceCandidate = {
    entityId: `entity:${input.id}`,
    name: input.name,
    absolutePath: `/workspace/sequences/kits/${input.kitId}/${input.name}.gb`,
    workspaceRelativePath: `sequences/kits/${input.kitId}/${input.name}.gb`,
    contentHash: `sha256:${input.id}`,
    objectUuid: `object:${input.id}`,
    sizeBytes: 500,
    sequenceDocument: { kind: 'catalog-sequence', entityId: `entity:${input.id}` },
  };
  return {
    id: input.id,
    name: input.name,
    route: 'restriction-digest',
    upstreamOverhang: input.upstream,
    downstreamOverhang: input.downstream,
    roleEvidence: [{ label: input.role, source: 'GenBank KEYWORDS Part subtype' }],
    kit: { id: input.kitId, name: input.kitName },
    source,
    fragment: digestFragment,
    digestFragments: [digestFragment],
    sourceSequence: 'A'.repeat(500),
    sourceAnnotations: [],
    sourceIsCircular: true,
    kitMemberId: input.id,
    kitPartTypeId: null,
  };
}

function renderWorkspace(overrides?: {
  model?: MocloWorkspaceModel;
  onChangeSchema?: ReturnType<typeof vi.fn>;
  onReplacePart?: ReturnType<typeof vi.fn>;
}) {
  const onChangeSchema = overrides?.onChangeSchema ?? vi.fn(() => ({ ok: true }));
  const onReplacePart = overrides?.onReplacePart ?? vi.fn();
  const onSelectRegion = vi.fn();
  const view = render(
    <MocloAssemblyWorkspace
      model={overrides?.model ?? cidarModel()}
      selectedRegionId="cidar-j23106-ab"
      onSelectRegion={onSelectRegion}
      onChangeSchema={onChangeSchema}
      onReplacePart={onReplacePart}
      workspaceRoot="/workspace"
      mapContent={<div data-testid="real-assembly-map">map</div>}
    />
  );
  return { ...view, onChangeSchema, onReplacePart, onSelectRegion };
}

describe('MocloAssemblyWorkspace', () => {
  beforeEach(() => {
    mockLoadCatalog.mockReset();
    mockLoadKitInventory.mockReset();
    mockLoadKitInventory.mockResolvedValue({ definitions: [YTK_DEFINITION], issues: [] });
    mockLoadCatalog.mockResolvedValue({
      candidates: [
        catalogCandidate({
          id: 'rbs',
          name: 'B0034m_BC',
          role: 'RBS',
          kitId: 'moclo-cidar',
          kitName: 'CIDAR MoClo',
          upstream: 'TACT',
          downstream: 'AATG',
        }),
        catalogCandidate({
          id: 'vector',
          name: 'DVA_BC',
          role: 'Destination vector',
          kitId: 'moclo-cidar',
          kitName: 'CIDAR MoClo',
          upstream: 'TACT',
          downstream: 'AATG',
        }),
        catalogCandidate({
          id: 'cross-kit-rbs',
          name: 'Cross-kit RBS',
          role: 'RBS',
          kitId: 'moclo-custom',
          kitName: 'Custom MoClo',
          upstream: 'TACT',
          downstream: 'AATG',
        }),
      ],
      skippedSourceCount: 0,
    });
  });

  it('shows one minimal Golden Gate schema without factory recipe or stage controls', () => {
    renderWorkspace({ model: ytkModel() });

    expect(screen.queryByText('Golden Gate schema')).not.toBeInTheDocument();
    expect(screen.queryByText('BsaI')).not.toBeInTheDocument();
    expect(screen.getByTestId('moclo-part-picker-2')).toHaveTextContent('pYTK051');
    expect(screen.queryByText(/ENO1 terminator/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/BsaI fragment \d+/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('combobox', { name: 'MoClo factory recipe' })
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId('moclo-factory-stages')).not.toBeInTheDocument();
    expect(screen.getByTestId('moclo-part-picker-3')).toBeDisabled();
    expect(screen.getByTestId('moclo-part-picker-3')).toHaveAccessibleName(
      'Cassette vector is supplied by a prior stage'
    );
  });

  it('waits for kit definitions before loading declared package members', async () => {
    let resolveInventory!: (value: {
      definitions: (typeof YTK_DEFINITION)[];
      issues: never[];
    }) => void;
    mockLoadKitInventory.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveInventory = resolve;
      })
    );
    renderWorkspace();

    fireEvent.click(screen.getByTestId('moclo-part-picker-1'));
    expect(mockLoadCatalog).not.toHaveBeenCalled();
    expect(screen.getByText('Indexing compatible parts…')).toBeInTheDocument();

    await act(async () => {
      resolveInventory({ definitions: [YTK_DEFINITION], issues: [] });
    });
    await waitFor(() => expect(mockLoadCatalog).toHaveBeenCalledTimes(1));
    expect(mockLoadCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ kitDefinitions: [YTK_DEFINITION] })
    );
  });

  it('closes an open picker when its slot becomes a prior-stage output', async () => {
    const model = cidarModel();
    const props = {
      model,
      selectedRegionId: 'cidar-j23106-ab',
      onSelectRegion: vi.fn(),
      onChangeSchema: vi.fn(() => ({ ok: true })),
      onReplacePart: vi.fn(),
      workspaceRoot: '/workspace',
      mapContent: <div data-testid="real-assembly-map">map</div>,
    };
    const { rerender } = render(<MocloAssemblyWorkspace {...props} />);

    fireEvent.click(screen.getByTestId('moclo-part-picker-1'));
    await screen.findByText('B0034m_BC');

    const updatedModel: MocloWorkspaceModel = {
      ...model,
      parts: model.parts.map((part, index) =>
        index === 1
          ? { ...part, input: { kind: 'stage-output', sourceStageId: 'prior-stage' } }
          : part
      ),
    };
    rerender(<MocloAssemblyWorkspace {...props} model={updatedModel} />);

    await waitFor(() =>
      expect(screen.queryByTestId('moclo-part-picker-popover')).not.toBeInTheDocument()
    );
    expect(screen.getByTestId('moclo-part-picker-1')).toBeDisabled();
    expect(screen.getByTestId('moclo-part-picker-1')).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps valid kit definitions available while reporting invalid manifests', async () => {
    mockLoadKitInventory.mockResolvedValueOnce({
      definitions: [YTK_DEFINITION],
      issues: [{ source: '/workspace/.forge/moclo-kits/broken.json', message: 'broken' }],
    });
    renderWorkspace();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '1 MoClo kit definition could not be loaded.'
    );
    fireEvent.click(screen.getByTestId('moclo-part-picker-1'));
    await waitFor(() => expect(mockLoadCatalog).toHaveBeenCalledTimes(1));
    expect(mockLoadCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ kitDefinitions: [YTK_DEFINITION] })
    );
  });

  it('never opens a kit-part picker for a slot supplied by an earlier factory stage', () => {
    const { onReplacePart } = renderWorkspace({ model: ytkModel() });

    fireEvent.click(screen.getByTestId('moclo-part-picker-3'));

    expect(screen.queryByTestId('moclo-part-picker-popover')).not.toBeInTheDocument();
    expect(onReplacePart).not.toHaveBeenCalled();
  });

  it('keeps one permanent connected schema chain above the same mounted map', () => {
    renderWorkspace();

    const strip = screen.getByTestId('moclo-schema-strip');
    const chain = within(strip).getByTestId('moclo-schema-chain');
    const parts = within(chain).getAllByTestId('moclo-schema-part');
    expect(strip).toBeInTheDocument();
    expect(screen.getByTestId('real-assembly-map')).toBeInTheDocument();
    expect(parts).toHaveLength(5);
    expect(parts.map((part) => part.getAttribute('data-entry-overhang'))).toEqual([
      'GGAG',
      'TACT',
      'AATG',
      'AGGT',
      'GCTT',
    ]);
    expect(parts.map((part) => part.getAttribute('data-exit-overhang'))).toEqual([
      'TACT',
      'AATG',
      'AGGT',
      'GCTT',
      'GGAG',
    ]);
    expect(parts.every((part) => part.getAttribute('data-connects-to-next') === 'true')).toBe(true);
    expect(parts.every((part) => part.classList.contains('rounded-md'))).toBe(true);
    expect(within(chain).queryByTestId('moclo-schema-part-shape')).not.toBeInTheDocument();
    expect(chain).not.toHaveTextContent(/[35]′/);
    expect(within(parts[0]).getByText('Promoter')).toBeInTheDocument();
    expect(within(chain).getByTestId('moclo-schema-junction-4')).toHaveTextContent('GGAG');
    expect(screen.queryByRole('button', { name: 'Schema' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('moclo-part-inspector')).not.toBeInTheDocument();
  });

  it('renders kit-defined junctions in the part ends without exposing schema editors', () => {
    const onChangeSchema = vi.fn(() => ({ ok: true }));
    renderWorkspace({ model: ytkModel(), onChangeSchema });

    const chain = screen.getByTestId('moclo-schema-chain');
    const parts = within(chain).getAllByTestId('moclo-schema-part');
    const junctions = parts.map((_, index) =>
      within(chain).getByTestId(`moclo-schema-junction-${index}`)
    );

    expect(chain).toHaveAttribute('data-junctions-locked', 'true');
    expect(parts.map((part) => part.getAttribute('data-entry-overhang'))).toEqual([
      'AACG',
      'TATG',
      'ATCC',
      'GCTG',
    ]);
    expect(junctions.map((junction) => junction.textContent)).toEqual([
      'TATG',
      'ATCC',
      'GCTG',
      'AACG',
    ]);
    expect(
      parts.map((_, index) =>
        within(chain)
          .getByTestId(`moclo-schema-junction-reverse-${index}`)
          .getAttribute('data-paired-complement')
      )
    ).toEqual(['ATAC', 'TAGG', 'CGAC', 'TTGC']);
    expect(junctions.every((junction) => junction.dataset.junctionLocked === 'true')).toBe(true);
    expect(screen.queryByRole('textbox', { name: /^Junction after / })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /^Position \d+ role$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ Position' })).not.toBeInTheDocument();
    expect(onChangeSchema).not.toHaveBeenCalled();
  });

  it('shows cross-kit physical matches and keeps a role mismatch selectable', async () => {
    const { onReplacePart, onSelectRegion } = renderWorkspace();

    fireEvent.click(screen.getByTestId('moclo-part-picker-1'));
    expect(onSelectRegion).toHaveBeenCalledWith('cidar-b0034m-bc');
    await screen.findByText('B0034m_BC');

    expect(screen.getByTestId('moclo-part-picker-popover')).toHaveAttribute(
      'data-menu-content',
      'panel'
    );
    expect(screen.getByRole('searchbox', { name: 'Search parts for RBS' })).toHaveAttribute(
      'data-menu-density',
      'form'
    );
    expect(screen.getByText('Cross-kit RBS')).toBeInTheDocument();
    expect(screen.queryByText(/Different part type/)).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId('moclo-part-picker-popover')).queryByRole('combobox')
    ).toBeNull();
    fireEvent.click(screen.getByText('DVA_BC'));
    expect(onReplacePart).toHaveBeenCalledWith(1, expect.objectContaining({ id: 'vector' }));
  });

  it('finds another kit through search without a kit submenu', async () => {
    renderWorkspace();
    fireEvent.click(screen.getByTestId('moclo-part-picker-1'));
    await screen.findByText('Cross-kit RBS');

    fireEvent.change(screen.getByRole('searchbox'), {
      target: { value: 'Custom MoClo' },
    });
    const picker = screen.getByTestId('moclo-part-picker-popover');
    expect(within(picker).getByText('Cross-kit RBS')).toBeInTheDocument();
    expect(within(picker).queryByText('B0034m_BC')).not.toBeInTheDocument();
  });

  it('keeps part metadata searchable without exposing a type submenu', async () => {
    renderWorkspace();
    fireEvent.click(screen.getByTestId('moclo-part-picker-1'));
    await screen.findByText('B0034m_BC');

    expect(screen.getByText('DVA_BC')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox'), {
      target: { value: 'RBS' },
    });

    const picker = screen.getByTestId('moclo-part-picker-popover');
    expect(within(picker).getByText('B0034m_BC')).toBeInTheDocument();
    expect(within(picker).getByText('Cross-kit RBS')).toBeInTheDocument();
    expect(within(picker).queryByText('DVA_BC')).not.toBeInTheDocument();
  });

  it('omits meaningless one-choice filters and internal indexing counts', async () => {
    mockLoadCatalog.mockResolvedValueOnce({
      candidates: [
        catalogCandidate({
          id: 'only-rbs',
          name: 'Only compatible RBS',
          role: 'RBS',
          kitId: 'moclo-cidar',
          kitName: 'CIDAR MoClo',
          upstream: 'TACT',
          downstream: 'AATG',
        }),
      ],
      skippedSourceCount: 3,
    });
    renderWorkspace();

    fireEvent.click(screen.getByTestId('moclo-part-picker-1'));
    await screen.findByText('Only compatible RBS');

    expect(screen.getByRole('searchbox')).toHaveAttribute('placeholder', 'Search parts…');
    expect(screen.queryByRole('combobox', { name: 'Filter by MoClo kit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Filter by part type' })).not.toBeInTheDocument();
    expect(screen.queryByText(/unreadable|oversized/i)).not.toBeInTheDocument();
  });

  it('does not misreport unreadable project parts as an empty compatible catalog', async () => {
    mockLoadCatalog.mockResolvedValueOnce({ candidates: [], skippedSourceCount: 2 });
    renderWorkspace();

    fireEvent.click(screen.getByTestId('moclo-part-picker-1'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Project parts could not be loaded.'
    );
    expect(screen.queryByText('No matching parts')).not.toBeInTheDocument();
  });

  it('explains why an explicitly revealed part is not physically compatible', async () => {
    mockLoadCatalog.mockResolvedValueOnce({
      candidates: [
        catalogCandidate({
          id: 'wrong-overhangs',
          name: 'Wrong-overhang RBS',
          role: 'RBS',
          kitId: 'moclo-cidar',
          kitName: 'CIDAR MoClo',
          upstream: 'AAAA',
          downstream: 'CCCC',
        }),
      ],
      skippedSourceCount: 0,
    });
    renderWorkspace();

    fireEvent.click(screen.getByTestId('moclo-part-picker-1'));
    await screen.findByText('No matching parts');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show incompatible overhangs' }));

    const candidate = await screen.findByTestId('moclo-candidate-wrong-overhangs');
    expect(candidate).toHaveTextContent('Left overhang mismatch · Right overhang mismatch');
  });

  it('reveals incompatible candidates without adding a type menu', async () => {
    mockLoadCatalog.mockResolvedValueOnce({
      candidates: [
        catalogCandidate({
          id: 'compatible-rbs',
          name: 'Compatible RBS',
          role: 'RBS',
          kitId: 'moclo-cidar',
          kitName: 'CIDAR MoClo',
          upstream: 'TACT',
          downstream: 'AATG',
        }),
        catalogCandidate({
          id: 'incompatible-promoter',
          name: 'Incompatible promoter',
          role: 'Promoter',
          kitId: 'moclo-cidar',
          kitName: 'CIDAR MoClo',
          upstream: 'AAAA',
          downstream: 'CCCC',
        }),
      ],
      skippedSourceCount: 0,
    });
    renderWorkspace();

    fireEvent.click(screen.getByTestId('moclo-part-picker-1'));
    await screen.findByText('Compatible RBS');
    expect(screen.queryByRole('combobox', { name: 'Filter by part type' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Show incompatible overhangs' }));
    expect(await screen.findByText('Incompatible promoter')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('moclo-part-picker-popover')).queryByRole('combobox')
    ).toBeNull();
  });

  it('identifies a PCR-routed part that needs primer overhangs', async () => {
    const candidate = catalogCandidate({
      id: 'pcr-rbs',
      name: 'PCR-routed RBS',
      role: 'RBS',
      kitId: 'moclo-custom',
      kitName: 'Custom MoClo',
      upstream: 'TACT',
      downstream: 'AATG',
    });
    mockLoadCatalog.mockResolvedValueOnce({
      candidates: [{ ...candidate, route: 'pcr' }],
      skippedSourceCount: 0,
    });
    renderWorkspace();

    fireEvent.click(screen.getByTestId('moclo-part-picker-1'));

    expect(await screen.findByTestId('moclo-candidate-pcr-rbs')).toHaveTextContent(
      'Primer overhangs needed'
    );
  });

  it('edits a junction as schema data and preserves the rest of the ordered schema', () => {
    const model = editableCidarModel();
    const onChangeSchema = vi.fn(() => ({ ok: true }));
    renderWorkspace({ model, onChangeSchema });

    const junction = screen.getByRole('textbox', { name: 'Junction after RBS' });
    fireEvent.change(junction, { target: { value: 'CGCT' } });
    expect(screen.getByTestId('moclo-schema-junction-reverse-1')).toHaveAttribute(
      'data-paired-complement',
      'GCGA'
    );
    fireEvent.blur(junction);

    expect(onChangeSchema).toHaveBeenCalledWith({
      ...model.schema,
      revision: model.schema.revision + 1,
      slots: model.schema.slots.map((slot, index) =>
        index === 1 ? { ...slot, outgoingOverhang: 'CGCT' } : slot
      ),
    });
  });

  it('adds a position through the same versioned schema callback', () => {
    const onChangeSchema = vi.fn(() => ({ ok: true }));
    renderWorkspace({ model: editableCidarModel(), onChangeSchema });

    fireEvent.click(screen.getByRole('button', { name: '+ Position' }));
    expect(onChangeSchema).toHaveBeenCalledWith(
      expect.objectContaining({
        slots: expect.arrayContaining([
          expect.objectContaining({ label: 'Position 6', outgoingOverhang: null }),
        ]),
      })
    );
  });

  it('reports a rejected schema edit instead of pretending it applied', async () => {
    renderWorkspace({
      model: editableCidarModel(),
      onChangeSchema: vi.fn(() => ({ ok: false, message: 'Stale schema.' })),
    });

    fireEvent.click(screen.getByRole('button', { name: '+ Position' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        userMessage('failure.schema-change-was-rejected')
      )
    );
  });

  it('discards catalog results from a workspace that stopped owning the design', async () => {
    const previousCandidate = catalogCandidate({
      id: 'previous-workspace',
      name: 'Previous workspace RBS',
      role: 'RBS',
      kitId: 'moclo-previous',
      kitName: 'Previous MoClo',
      upstream: 'TACT',
      downstream: 'AATG',
    });
    const currentCandidate = catalogCandidate({
      id: 'current-workspace',
      name: 'Current workspace RBS',
      role: 'RBS',
      kitId: 'moclo-current',
      kitName: 'Current MoClo',
      upstream: 'TACT',
      downstream: 'AATG',
    });
    let resolvePrevious!: (result: LoadMocloCatalogCandidatesResult) => void;
    const previousResult = new Promise<LoadMocloCatalogCandidatesResult>((resolve) => {
      resolvePrevious = resolve;
    });
    let previousSignal: AbortSignal | undefined;
    mockLoadCatalog
      .mockImplementationOnce((input: LoadMocloCatalogCandidatesInput) => {
        previousSignal = input.abortSignal;
        return previousResult;
      })
      .mockResolvedValueOnce({ candidates: [currentCandidate], skippedSourceCount: 0 });

    const model = cidarModel();
    const props = {
      model,
      selectedRegionId: 'cidar-j23106-ab',
      onSelectRegion: vi.fn(),
      onChangeSchema: vi.fn(() => ({ ok: true })),
      onReplacePart: vi.fn(),
      mapContent: <div data-testid="real-assembly-map">map</div>,
    };
    const { rerender } = render(
      <MocloAssemblyWorkspace {...props} workspaceRoot="/workspace/previous" />
    );

    fireEvent.click(screen.getByTestId('moclo-part-picker-1'));
    await waitFor(() => expect(mockLoadCatalog).toHaveBeenCalledTimes(1));
    rerender(<MocloAssemblyWorkspace {...props} workspaceRoot="/workspace/current" />);
    await waitFor(() => expect(previousSignal?.aborted).toBe(true));
    await waitFor(() => expect(screen.queryByTestId('moclo-part-picker-popover')).toBeNull());

    fireEvent.click(screen.getByTestId('moclo-part-picker-1'));
    await screen.findByText('Current workspace RBS');
    await act(async () => {
      resolvePrevious({ candidates: [previousCandidate], skippedSourceCount: 0 });
      await previousResult;
    });

    expect(screen.getByText('Current workspace RBS')).toBeInTheDocument();
    expect(screen.queryByText('Previous workspace RBS')).not.toBeInTheDocument();
  });

  it('refreshes an open picker after package reconciliation completes', async () => {
    const reconciledCandidate = catalogCandidate({
      id: 'reconciled-rbs',
      name: 'Package-backed RBS',
      role: 'RBS',
      kitId: 'moclo-cidar',
      kitName: 'CIDAR MoClo',
      upstream: 'TACT',
      downstream: 'AATG',
    });
    renderWorkspace();
    fireEvent.click(screen.getByTestId('moclo-part-picker-1'));
    await screen.findByText('B0034m_BC');

    mockLoadCatalog.mockResolvedValueOnce({
      candidates: [reconciledCandidate],
      skippedSourceCount: 0,
    });
    const registered: Array<Promise<unknown>> = [];
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('waypoint:workspace-reconciled', {
          detail: {
            path: null,
            workspaceRoot: '/workspace',
            register: (promise: Promise<unknown>) => registered.push(promise),
          },
        })
      );
      await Promise.all(registered);
    });

    expect(mockLoadCatalog).toHaveBeenCalledTimes(2);
    const picker = screen.getByTestId('moclo-part-picker-popover');
    expect(within(picker).getByText('Package-backed RBS')).toBeInTheDocument();
    expect(within(picker).queryByText('B0034m_BC')).not.toBeInTheDocument();
  });
});
