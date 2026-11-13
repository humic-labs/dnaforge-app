import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDesignStore } from '../store';
import type { AssemblyState, SequenceDesign } from '../types';
import { DesignDrawer } from './DesignDrawer';

vi.mock('../../assembly-panel', () => ({
  AssemblyPanelContent: ({ designId }: { designId: string }) => (
    <div data-testid="assembly-panel-content">{designId}</div>
  ),
}));

describe('DesignDrawer', () => {
  beforeEach(() => {
    useDesignStore.setState({
      designs: {},
      activeDesignId: null,
      pendingDispatchId: null,
    });
  });

  it('renders all assembly states with data-assembly-state', () => {
    const states: AssemblyState[] = [
      'preflight',
      'drafting',
      'validating',
      'ready',
      'running',
      'assembled',
    ];

    for (const state of states) {
      useDesignStore.setState({
        designs: { design1: createDesign(state) },
        pendingDispatchId: state === 'validating' || state === 'running' ? 'dispatch-1' : null,
      });

      const { unmount } = render(
        <DesignDrawer designId="design1" width={640} onWidthChange={vi.fn()} />
      );

      expect(screen.getByTestId('design-drawer')).toHaveAttribute('data-assembly-state', state);
      expect(screen.getByTestId('assembly-panel-content')).toHaveTextContent('design1');
      unmount();
    }
  });

  it('does not duplicate top-bar assembly actions for ready designs', () => {
    useDesignStore.setState({
      designs: { design1: createDesign('ready') },
    });

    render(<DesignDrawer designId="design1" width={640} onWidthChange={vi.fn()} />);

    expect(screen.queryByText('Recalculate')).not.toBeInTheDocument();
    expect(screen.queryByText('Clear Draft')).not.toBeInTheDocument();
    expect(screen.queryByText('Assembly inputs are up to date.')).not.toBeInTheDocument();
    expect(screen.queryByText('Design 1')).not.toBeInTheDocument();
  });

  it('does not pin a catch-all assembly-issues gutter under the drawer', () => {
    useDesignStore.setState({
      designs: {
        design1: {
          ...createDesign('drafting'),
          assemblyMethod: 'goldengate',
          goldenGateConfig: { enzyme: 'BsaI' },
          regions: [
            {
              id: 'a',
              sourceSequenceId: 'source-a',
              sourceSequenceName: 'A',
              sourceStart: 0,
              sourceEnd: 120,
              sequence: 'ATCG'.repeat(30),
              annotations: [],
              sourceType: 'rd',
              ggType: 'insert',
              rdOverhangs: { upstream: 'AATG', downstream: 'GCTA' },
              rdSourceEnzyme: 'BsmBI',
              rdSourceEnzymeName: 'BsmBI',
            },
            {
              id: 'b',
              sourceSequenceId: 'source-b',
              sourceSequenceName: 'B',
              sourceStart: 0,
              sourceEnd: 120,
              sequence: 'GCTA'.repeat(30),
              annotations: [],
              sourceType: 'pcr',
            },
          ],
        },
      },
    });

    render(<DesignDrawer designId="design1" width={640} onWidthChange={vi.fn()} />);

    expect(screen.queryByTestId('assembly-issue-panel')).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        'A was produced by BsmBI, so it cannot be used in a BsaI Golden Gate reaction.'
      )
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Validation')).not.toBeInTheDocument();
  });
});

function createDesign(assemblyState: AssemblyState): SequenceDesign {
  const now = new Date('2026-04-26T00:00:00.000Z');
  return {
    id: 'design1',
    name: 'Design 1',
    topology: 'circular',
    regions: [
      {
        id: 'fragment-1',
        sourceSequenceId: 'source-1',
        sourceSequenceName: 'Source 1',
        sourceStart: 0,
        sourceEnd: 120,
        sequence: 'ATCG'.repeat(30),
        annotations: [],
      },
    ],
    spacers: [],
    version: 1,
    assemblyState,
    validationErrors: [],
    proposedPlans: [],
    status:
      assemblyState === 'ready'
        ? 'computed'
        : assemblyState === 'assembled'
          ? 'assembled'
          : 'draft',
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

describe('DesignDrawer resize drag', () => {
  function makeDesign(): SequenceDesign {
    const now = new Date('2026-05-10T00:00:00.000Z');
    return {
      id: 'drag-design',
      name: 'Drag',
      topology: 'linear',
      regions: [],
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

  it('starts from the RENDERED width, not the remembered one', () => {
    const d = makeDesign();
    useDesignStore.setState({ designs: { [d.id]: d }, activeDesignId: d.id });
    const onWidthChange = vi.fn();

    render(<DesignDrawer designId={d.id} width={640} onWidthChange={onWidthChange} />);

    const panel = screen.getByTestId('design-drawer');
    vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue({
      width: 200,
      height: 800,
      top: 0,
      left: 0,
      right: 200,
      bottom: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    fireEvent.mouseDown(screen.getByTestId('design-drawer-drag-handle'), { clientX: 500 });
    fireEvent.mouseMove(document, { clientX: 480 });

    expect(onWidthChange).toHaveBeenCalledWith(220);
    expect(onWidthChange).not.toHaveBeenCalledWith(660);

    fireEvent.mouseUp(document);
  });
});
