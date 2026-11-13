import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DesignRegion, SequenceDesign } from '../../design/types';
import { AssemblyMethodSection } from './AssemblyMethodSection';

vi.mock('../../junction-workbench', () => ({
  JunctionWorkbench: ({ design }: { design: SequenceDesign }) => (
    <div data-testid="junction-workbench" data-design-id={design.id} />
  ),
}));

function makePcrRegion(id: string, sequence: string): DesignRegion {
  return {
    id,
    sourceSequenceId: `source-${id}`,
    sourceSequenceName: id,
    sourceStart: 0,
    sourceEnd: sequence.length,
    sequence,
    annotations: [],
    sourceType: 'pcr',
  };
}

function makeDesign(
  overrides: Partial<SequenceDesign> = {},
  regions: DesignRegion[] = [
    makePcrRegion('pcr-a', 'ATGCGTACGATCGTACGATC'),
    makePcrRegion('pcr-b', 'CAGTTACCGGTACGATCGTA'),
  ]
): SequenceDesign {
  return {
    id: 'assembly-method-section-design',
    name: 'Assembly method section fixture',
    topology: 'circular',
    regions,
    spacers: [],
    version: 1,
    assemblyState: 'ready',
    validationErrors: [],
    proposedPlans: [],
    status: 'computed',
    assemblyMethod: 'goldengate',
    defaultHomologyLength: 30,
    homologyRegions: [],
    goldenGateConfig: { enzyme: 'BsaI' },
    goldenGateJunctions: [
      {
        index: 0,
        leftRegionId: regions[0]?.id ?? 'left',
        rightRegionId: regions[1]?.id ?? 'right',
        overhang: 'ATGC',
        isValid: true,
        validationError: null,
        offset: 0,
      },
    ],
    designPrimers: [],
    selectedJunctionIndex: null,
    scrollToPosition: null,
    highlightRange: null,
    createdAt: new Date('2026-04-27T00:00:00Z'),
    updatedAt: new Date('2026-04-27T00:00:00Z'),
    ...overrides,
  };
}

describe('AssemblyMethodSection', () => {
  it('renders the linked junction workbench for GoldenGate designs with junctions', () => {
    const design = makeDesign();

    render(<AssemblyMethodSection design={design} />);

    expect(screen.getByTestId('junction-workbench')).toHaveAttribute('data-design-id', design.id);
    expect(screen.queryByText(/No primer design yet/i)).not.toBeInTheDocument();
  });

  it('renders the linked junction workbench for homology designs with homology regions', () => {
    const design = makeDesign({
      id: 'homology-design',
      assemblyMethod: 'gibson',
      goldenGateConfig: undefined,
      goldenGateJunctions: undefined,
      homologyRegions: [
        {
          index: 0,
          start: 10,
          end: 40,
          sequence: 'ATGCGTACGATCGTACGATC',
          metadata: {
            leftRegionId: 'pcr-a',
            rightRegionId: 'pcr-b',
          },
        },
      ],
    });

    render(<AssemblyMethodSection design={design} />);

    expect(screen.getByTestId('junction-workbench')).toHaveAttribute('data-design-id', design.id);
    expect(screen.queryByText(/No primer design yet/i)).not.toBeInTheDocument();
  });

  it('keeps the workbench visible before a draft exists', () => {
    const design = makeDesign({ goldenGateJunctions: [] });

    render(<AssemblyMethodSection design={design} />);

    expect(screen.getByTestId('junction-workbench')).toHaveAttribute('data-design-id', design.id);
    expect(screen.queryByText(/No primer design yet/i)).not.toBeInTheDocument();
  });
});
