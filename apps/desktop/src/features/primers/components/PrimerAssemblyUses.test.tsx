import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcceptedAssemblyOligoUse } from '../../assembly/public/accepted-oligo-uses';
import type { SavedPrimerLink } from '../../design/public/saved-primer-links';
import { useDesignStore } from '../../design/public/store';
import type { DesignPrimer, SequenceDesign } from '../../design/public/types';
import {
  buildPrimerArtifact,
  type PrimerArtifactBuildInput,
  type PrimerArtifactV1,
} from '../primer-artifact';
import { PrimerAssemblyUses } from './PrimerAssemblyUses';

const navigation = vi.hoisted(() => ({ openDocument: vi.fn() }));
const acceptedAssemblies = vi.hoisted(() => ({ acceptedAssemblyUsesOfOligo: vi.fn() }));

vi.mock('../../document-opening/public/open-document', () => ({
  openDocument: navigation.openDocument,
}));

vi.mock('../../assembly/public/accepted-oligo-uses', () => ({
  acceptedAssemblyUsesOfOligo: acceptedAssemblies.acceptedAssemblyUsesOfOligo,
}));

vi.mock('../../junction-workbench/public/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../junction-workbench/public/settings')>()),
  describeAssemblyTmContext: (polymerase?: string | null) => ({
    evaluates: 'binding-part' as const,
    modelLabel: polymerase === 'q5' ? 'NEB Q5' : 'Default (SantaLucia)',
    primerConcNm: polymerase === 'q5' ? 500 : 250,
  }),
}));

const TAIL = 'AGAGGAGAAATACTA';
const BINDING = 'ATGAGTTTATGGAAAAAAATCAGCCTCGG';
const OLIGO = `${TAIL}${BINDING}`;
const SITE_START = 518478;

function primer(
  id: string,
  direction: 'forward' | 'reverse',
  sequence: string,
  binding: string
): DesignPrimer {
  const tail = sequence.slice(0, sequence.length - binding.length);
  return {
    id,
    name: `F1 ${direction}`,
    sequence,
    pbs: { start: 0, end: binding.length, sequence: binding },
    overhang: { length: tail.length, sequence: tail, tailLength: tail.length },
    direction,
    fragmentIndex: 0,
    junctionIndex: 0,
    tm: 58.2,
  };
}

function link(artifact: PrimerArtifactV1, overrides: Partial<SavedPrimerLink> = {}) {
  return {
    primerId: 'p-f',
    oligoId: artifact.id,
    artifactRevision: artifact.artifactRevision,
    sequenceContentHash: artifact.sequence.contentHash,
    linkedAtDesignVersion: 11,
    linkedAt: '2026-11-10T12:00:00.000Z',
    via: 'matched-existing',
    ...overrides,
  } satisfies SavedPrimerLink;
}

const DESIGN_DEFAULTS = {
  topology: 'circular',
  assemblyState: 'ready',
  validationErrors: [],
  proposedPlans: [],
  defaultHomologyLength: 30,
  homologyRegions: [],
  selectedJunctionIndex: null,
  scrollToPosition: null,
  highlightRange: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
} satisfies Partial<SequenceDesign>;

function design(overrides: Partial<SequenceDesign> = {}): SequenceDesign {
  return {
    ...DESIGN_DEFAULTS,
    id: 'design-1',
    name: 'TamB Gibson',
    version: 12,
    assemblyMethod: 'gibson',
    spacers: [],
    regions: [
      {
        id: 'insert',
        sourceSequenceId: 'doc-genome',
        sourceSequenceName: 'E. coli K-12',
        sourceStart: SITE_START,
        sourceEnd: SITE_START + 80,
        sourceLength: 4641652,
        sourceIsCircular: true,
        sequence: `${BINDING}${'G'.repeat(51)}`,
        annotations: [],
      },
    ],
    designPrimers: [
      {
        fragmentIndex: 0,
        forward: primer('p-f', 'forward', OLIGO, BINDING),
        reverse: primer('p-r', 'reverse', 'TTATTTGATGCCTGGCCCCCCCCCCCCCCCC', 'CCCCCCCCCCCCCCCC'),
      },
    ],
    ...overrides,
  };
}

function artifactFor(overrides: Partial<PrimerArtifactBuildInput> = {}) {
  return buildPrimerArtifact({
    id: 'oligo-380',
    catalogNumber: 'P380',
    name: 'tamB forward',
    sequence: OLIGO,
    workspaceRoot: '/workspace/project',
    artifactPath: '/workspace/project/primers/tamB-forward.primer.json',
    source: 'manual',
    ...overrides,
  });
}

const tmCalculation: NonNullable<PrimerArtifactBuildInput['tmCalculation']> = {
  model: { kind: 'neb', polymerase: 'q5', prodcode: 'q5-0' },
  source: 'user-setting',
  reason: 'App-wide Tm model chosen in settings (NEB Q5).',
  valueC: 72.4,
  status: 'verified',
  provider: {
    source: 'neb-api',
    tm: 72.4,
    conc_nM: 500,
    verified: true,
    polymerase: 'q5',
    prodcode: 'q5-0',
    nebApiVersion: '0.19.0',
    fetchedAt: '2026-08-10T12:00:00.000Z',
  },
};

function seedDesigns(...designs: SequenceDesign[]) {
  useDesignStore.setState({
    designs: Object.fromEntries(designs.map((item) => [item.id, item])),
  });
}

const ACCEPTED_AT = '2026-10-01T19:30:00.000Z';
const ACCEPTED_AT_LABEL = new Date(ACCEPTED_AT).toLocaleString('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function acceptedUse(overrides: Partial<AcceptedAssemblyOligoUse> = {}): AcceptedAssemblyOligoUse {
  return {
    constructId: 'construct-1',
    packageId: 'construct-1',
    packageRoot: '/workspace/project/pTamB',
    acceptedAssemblyVersionId: 'accepted-1',
    designId: 'design-1',
    designName: 'pTamB-GFP',
    acceptedAt: ACCEPTED_AT,
    assemblyMethod: 'gibson',
    isCurrentAccepted: true,
    primers: [
      {
        primerId: 'p-f',
        primerName: 'F1 forward',
        partNumber: 1,
        direction: 'forward',
        artifactRevision: 2,
        sequenceContentHash: 'sha256:oligo-380-r2',
        sequence: OLIGO,
        bindingSequence: BINDING,
        tailSequence: TAIL,
      },
    ],
    ...overrides,
  };
}

function seedAcceptedUses(...uses: AcceptedAssemblyOligoUse[]) {
  acceptedAssemblies.acceptedAssemblyUsesOfOligo.mockResolvedValue({ uses, unreadable: [] });
}

describe('PrimerAssemblyUses', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    navigation.openDocument.mockResolvedValue({ status: 'presented' });
    seedAcceptedUses();
    seedDesigns();
  });

  it('renders nothing for an oligo no assembly uses', async () => {
    const artifact = await artifactFor();
    seedDesigns(design());

    const view = render(<PrimerAssemblyUses artifact={artifact} />);

    expect(view.container).toBeEmptyDOMElement();
  });

  it('shows the assembly, the tail and binding split, the source site and both Tm values', async () => {
    const artifact = await artifactFor({
      annealing: { pbsSequence: BINDING, overhangSequence: TAIL },
      tmCalculation,
      binding: {
        id: 'binding-1',
        targetDocumentId: 'doc-genome',
        targetFilePath: '/workspace/project/genome.gb',
        targetLength: 4641652,
        targetTopology: 'circular',
        targetFileContentHash: 'target-file-sha256',
        targetNormalizedSequenceHash: 'target-sequence-sha256',
        start: SITE_START,
        end: SITE_START + BINDING.length,
        strand: 1,
      },
    });
    seedDesigns(design({ savedPrimerLinks: [link(artifact)] }));

    render(<PrimerAssemblyUses artifact={artifact} />);

    const section = screen.getByTestId('primer-assembly-uses');
    expect(section).toHaveAttribute('aria-label', 'Assemblies using this oligo');
    expect(within(section).getByRole('heading', { name: 'Used in assemblies' })).toBeVisible();
    const use = screen.getByTestId('primer-assembly-use');
    expect(use).toHaveAttribute('data-design-id', 'design-1');
    expect(use).toHaveAttribute('data-primer-id', 'p-f');
    expect(use).toHaveAttribute('data-link-state', 'current');
    expect(screen.getByTestId('primer-assembly-use-open-design')).toHaveTextContent('TamB Gibson');
    expect(use).toHaveTextContent('Part 1 · forward · Gibson · design version 12');
    expect(screen.getByTestId('primer-assembly-use-revision')).toHaveTextContent(
      /^Linked at design version 11, oligo revision 1$/
    );
    expect(screen.getByTestId('primer-assembly-use-tail')).toHaveTextContent(
      `5′ tail (15 nt)${TAIL}`
    );
    expect(screen.getByTestId('primer-assembly-use-binding')).toHaveTextContent(
      `Binding part (29 nt)${BINDING}`
    );
    const source = screen.getByTestId('primer-assembly-use-source');
    expect(source).toHaveTextContent('Binds E. coli K-12 518,479–518,507 (+)');
    expect(source).toHaveTextContent(
      "Same site as this oligo's saved attachment (manual placement)"
    );
    const tm = screen.getByTestId('primer-assembly-use-tm');
    expect(tm).toHaveTextContent(
      'Assembly Tm 58.2 °C · binding part · Default (SantaLucia) · 250 nM'
    );
    expect(tm).toHaveTextContent('Saved oligo Tm 72.4 °C · NEB Q5 · 500 nM · binding part');
    expect(tm).toHaveTextContent('The two values use different primer concentrations.');
    expect(use).not.toHaveTextContent('no longer matches');
  });

  it('marks a matcher-confirmed attachment and a saved Tm with no recorded binding part', async () => {
    const artifact = await artifactFor({
      binding: {
        id: 'binding-1',
        targetDocumentId: 'doc-genome',
        targetFilePath: '/workspace/project/genome.gb',
        targetLength: 4641652,
        targetTopology: 'circular',
        targetFileContentHash: 'target-file-sha256',
        targetNormalizedSequenceHash: 'target-sequence-sha256',
        start: SITE_START,
        end: SITE_START + BINDING.length,
        strand: 1,
      },
    });
    const confirmed: PrimerArtifactV1 = {
      ...artifact,
      bindings: artifact.bindings.map((binding) => ({
        ...binding,
        alignment: {
          identity: 1,
          editDistance: 0,
          mismatchPositions: [],
          threePrimeMatchLength: BINDING.length,
          effectiveTmC: 58.2,
        },
      })),
    };
    seedDesigns(design({ savedPrimerLinks: [link(artifact)] }));

    render(<PrimerAssemblyUses artifact={confirmed} />);

    expect(screen.getByTestId('primer-assembly-use-source')).toHaveTextContent(
      "Same site as this oligo's saved attachment (manual placement, matcher-confirmed)"
    );
    const tm = screen.getByTestId('primer-assembly-use-tm');
    expect(tm).toHaveTextContent(
      `Saved oligo Tm ${artifact.computed.tmC!.toFixed(1)} °C · evaluated bases not recorded`
    );
    expect(tm).not.toHaveTextContent('different primer concentrations');
  });

  it('says when the saved attachment is elsewhere, when no site is known and when there is no tail', async () => {
    const artifact = await artifactFor({
      binding: {
        id: 'binding-1',
        targetDocumentId: 'doc-genome',
        targetFilePath: '/workspace/project/genome.gb',
        targetLength: 4641652,
        targetTopology: 'circular',
        targetFileContentHash: 'target-file-sha256',
        targetNormalizedSequenceHash: 'target-sequence-sha256',
        start: 100,
        end: 129,
        strand: 1,
      },
    });
    const untailed = await artifactFor({
      id: 'oligo-381',
      catalogNumber: 'P381',
      sequence: BINDING,
    });
    const base = design();
    seedDesigns(
      design({ savedPrimerLinks: [link(artifact)] }),
      design({
        id: 'design-2',
        name: 'Untailed design',
        assemblyMethod: 'goldengate',
        pcrPolymerase: 'q5',
        regions: [{ ...base.regions[0]!, sequence: 'G'.repeat(80) }],
        designPrimers: [
          {
            ...base.designPrimers[0]!,
            forward: { ...primer('p-f', 'forward', BINDING, BINDING), tm: undefined },
          },
        ],
        savedPrimerLinks: [link(untailed)],
      })
    );

    const first = render(<PrimerAssemblyUses artifact={artifact} />);
    expect(screen.getByTestId('primer-assembly-use-source')).toHaveTextContent(
      "This oligo's saved attachment on that source is at a different site"
    );
    first.unmount();

    render(<PrimerAssemblyUses artifact={untailed} />);
    const use = screen.getByTestId('primer-assembly-use');
    expect(use).toHaveAttribute('data-design-id', 'design-2');
    expect(use).toHaveTextContent('Part 1 · forward · Golden Gate · design version 12');
    expect(screen.getByTestId('primer-assembly-use-tail')).toHaveTextContent('5′ tail (0 nt)None');
    expect(screen.getByTestId('primer-assembly-use-source')).toHaveTextContent(
      /^Source binding site unavailable for this primer$/
    );
    expect(screen.getByTestId('primer-assembly-use-tm')).toHaveTextContent(
      'Assembly Tm unavailable'
    );
  });

  it('warns when the draft primer or the oligo changed after linking', async () => {
    const artifact = await artifactFor();
    const base = design();
    seedDesigns(
      design({
        designPrimers: [
          {
            ...base.designPrimers[0]!,
            forward: primer('p-f', 'forward', `AA${OLIGO}`, BINDING),
          },
        ],
        savedPrimerLinks: [link(artifact)],
      }),
      design({
        id: 'design-2',
        name: 'Zeta design',
        designPrimers: [
          {
            ...base.designPrimers[0]!,
            forward: primer('p-f', 'forward', `CC${OLIGO}`, BINDING),
          },
        ],
        savedPrimerLinks: [link(artifact, { sequenceContentHash: 'hash-before-edit' })],
      })
    );

    render(<PrimerAssemblyUses artifact={{ ...artifact, artifactRevision: 3 }} />);

    const [draftChanged, oligoChanged] = screen.getAllByTestId('primer-assembly-use');
    expect(draftChanged).toHaveAttribute('data-link-state', 'draft-primer-changed');
    expect(draftChanged).toHaveTextContent('The draft primer no longer matches this oligo.');
    expect(oligoChanged).toHaveAttribute('data-link-state', 'oligo-bases-changed');
    expect(oligoChanged).toHaveTextContent("This oligo's bases changed after it was linked.");
    expect(within(draftChanged!).getByTestId('primer-assembly-use-revision')).toHaveTextContent(
      'Linked at design version 11, oligo revision 1; this oligo is now revision 3'
    );
  });

  it('opens the design and reports an open that fails', async () => {
    const artifact = await artifactFor();
    seedDesigns(design({ savedPrimerLinks: [link(artifact)] }));
    render(<PrimerAssemblyUses artifact={artifact} />);

    fireEvent.click(screen.getByTestId('primer-assembly-use-open-design'));

    expect(navigation.openDocument).toHaveBeenCalledExactlyOnceWith({
      target: { kind: 'record', tabType: 'design', entityId: 'design-1' },
      label: 'TamB Gibson',
    });
    await waitFor(() => expect(navigation.openDocument).toHaveResolved());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    navigation.openDocument.mockResolvedValue({
      status: 'failed',
      message: 'The destination panel is no longer available.',
    });
    fireEvent.click(screen.getByTestId('primer-assembly-use-open-design'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'We couldn’t complete that action. Try again.'
    );
  });

  it('follows the design store when a link is added', async () => {
    const artifact = await artifactFor();
    seedDesigns(design());
    render(<PrimerAssemblyUses artifact={artifact} />);
    expect(screen.queryByTestId('primer-assembly-uses')).not.toBeInTheDocument();

    act(() => {
      useDesignStore.getState().setSavedPrimerLinks('design-1', [link(artifact)]);
    });

    expect(await screen.findByTestId('primer-assembly-use')).toHaveAttribute(
      'data-design-id',
      'design-1'
    );
  });

  it('lists a finalized assembly for an oligo whose draft design is gone', async () => {
    const artifact = await artifactFor();
    seedAcceptedUses(acceptedUse());

    render(<PrimerAssemblyUses artifact={{ ...artifact, artifactRevision: 5 }} />);

    expect(acceptedAssemblies.acceptedAssemblyUsesOfOligo).toHaveBeenCalledExactlyOnceWith({
      oligoId: 'oligo-380',
    });
    const accepted = await screen.findByTestId('primer-accepted-assembly-use');
    expect(screen.getByTestId('primer-accepted-assembly-uses')).toBeVisible();
    expect(
      within(screen.getByTestId('primer-assembly-uses')).getByRole('heading', {
        name: 'Accepted (finalized) assemblies',
      })
    ).toBeVisible();
    expect(accepted).toHaveAttribute('data-construct-id', 'construct-1');
    expect(accepted).toHaveAttribute('data-accepted-assembly-version-id', 'accepted-1');
    expect(accepted).toHaveAttribute('data-accepted-record', 'current');
    expect(screen.getByTestId('primer-accepted-assembly-use-open')).toHaveTextContent('pTamB-GFP');
    expect(accepted).toHaveTextContent(`Accepted · Gibson · ${ACCEPTED_AT_LABEL}`);
    expect(screen.getByTestId('primer-accepted-assembly-use-primer')).toHaveAttribute(
      'data-primer-id',
      'p-f'
    );
    expect(accepted).toHaveTextContent('Part 1 · forward · F1 forward');
    expect(screen.getByTestId('primer-accepted-assembly-use-revision')).toHaveTextContent(
      /^Accepted with oligo revision 2; this oligo is now revision 5$/
    );
    expect(screen.getByTestId('primer-accepted-assembly-use-tail')).toHaveTextContent(
      `5′ tail (15 nt)${TAIL}`
    );
    expect(screen.getByTestId('primer-accepted-assembly-use-binding')).toHaveTextContent(
      `Binding part (29 nt)${BINDING}`
    );
    expect(screen.queryByTestId('primer-draft-assembly-uses')).not.toBeInTheDocument();
    expect(screen.queryByTestId('primer-assembly-use')).not.toBeInTheDocument();
  });

  it('shows the finalized assemblies alongside the draft designs', async () => {
    const artifact = await artifactFor();
    seedAcceptedUses(acceptedUse());
    seedDesigns(design({ savedPrimerLinks: [link(artifact)] }));

    render(<PrimerAssemblyUses artifact={artifact} />);

    expect(await screen.findByTestId('primer-accepted-assembly-use')).toBeVisible();
    expect(screen.getByTestId('primer-draft-assembly-uses')).toBeVisible();
    expect(
      within(screen.getByTestId('primer-draft-assembly-uses')).getByRole('heading', {
        name: 'Draft designs',
      })
    ).toBeVisible();
    expect(screen.getByTestId('primer-assembly-use')).toHaveAttribute('data-design-id', 'design-1');
    expect(screen.getByTestId('primer-accepted-assembly-use-revision')).toHaveTextContent(
      /^Accepted with oligo revision 2$/
    );
  });

  it('marks a superseded accepted version and an acceptance that recorded no bases', async () => {
    const artifact = await artifactFor();
    seedAcceptedUses(
      acceptedUse({
        acceptedAssemblyVersionId: 'accepted-prior',
        isCurrentAccepted: false,
        assemblyMethod: 'goldengate',
        primers: [
          {
            primerId: 'p-retired',
            primerName: null,
            partNumber: null,
            direction: null,
            artifactRevision: 1,
            sequenceContentHash: 'sha256:oligo-380-r1',
            sequence: null,
            bindingSequence: null,
            tailSequence: null,
          },
        ],
      })
    );

    render(<PrimerAssemblyUses artifact={artifact} />);

    const accepted = await screen.findByTestId('primer-accepted-assembly-use');
    expect(accepted).toHaveAttribute('data-accepted-record', 'superseded');
    expect(accepted).toHaveTextContent('Superseded accepted version · Golden Gate');
    expect(accepted).toHaveTextContent('Part unavailable');
    expect(screen.getByTestId('primer-accepted-assembly-use-bases')).toHaveTextContent(
      'Ordered bases were not recorded with this accepted assembly'
    );
    expect(screen.queryByTestId('primer-accepted-assembly-use-binding')).not.toBeInTheDocument();
  });

  it('opens the finalized package and reports an open that fails', async () => {
    const artifact = await artifactFor();
    seedAcceptedUses(acceptedUse());
    render(<PrimerAssemblyUses artifact={artifact} />);
    await screen.findByTestId('primer-accepted-assembly-use');

    fireEvent.click(screen.getByTestId('primer-accepted-assembly-use-open'));

    expect(navigation.openDocument).toHaveBeenCalledExactlyOnceWith({
      target: { kind: 'sequence-package', path: '/workspace/project/pTamB' },
      label: 'pTamB-GFP',
    });
    await waitFor(() => expect(navigation.openDocument).toHaveResolved());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    navigation.openDocument.mockResolvedValue({
      status: 'failed',
      message: 'The destination panel is no longer available.',
    });
    fireEvent.click(screen.getByTestId('primer-accepted-assembly-use-open'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'We couldn’t complete that action. Try again.'
    );
  });

  it('stays empty when the accepted read path fails', async () => {
    const artifact = await artifactFor();
    acceptedAssemblies.acceptedAssemblyUsesOfOligo.mockRejectedValue(new Error('catalog closed'));

    const view = render(<PrimerAssemblyUses artifact={artifact} />);

    await waitFor(() =>
      expect(acceptedAssemblies.acceptedAssemblyUsesOfOligo).toHaveBeenCalledOnce()
    );
    expect(view.container).toBeEmptyDOMElement();
  });
});
