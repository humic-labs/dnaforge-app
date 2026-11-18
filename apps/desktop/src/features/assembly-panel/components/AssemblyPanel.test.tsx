import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { useDesignStore } from '../../design/store';
import type { SequenceDesign } from '../../design/types';
import { useSettingsStore } from '../../junction-workbench/settings';
import { DEFAULT_TM_MODEL } from '../../design/algorithms/tm-model';
import {
  resolveAssemblyDrawerWheelInteraction,
  shouldRouteWheelToAssemblyDrawer,
  type AssemblyDrawerWheelAxisLock,
} from './AssemblyPanelWheel';
import { AssemblyPanelContent } from './AssemblyPanel';

describe('assembly drawer wheel routing', () => {
  it('captures vertical-dominant wheel gestures over horizontal junction viewers', () => {
    const horizontalViewer = document.createElement('div');
    horizontalViewer.dataset.assemblyHorizontalScroll = 'true';
    const nestedTarget = document.createElement('div');
    horizontalViewer.appendChild(nestedTarget);

    expect(shouldRouteWheelToAssemblyDrawer(8, 48, nestedTarget)).toBe(true);
    expect(shouldRouteWheelToAssemblyDrawer(48, 8, nestedTarget)).toBe(false);
    expect(shouldRouteWheelToAssemblyDrawer(0, 48, document.createElement('div'))).toBe(false);
  });

  it('locks a trackpad burst to vertical after it starts vertical over a junction viewer', () => {
    const nestedTarget = horizontalScrollTarget();
    let lock: AssemblyDrawerWheelAxisLock | null = null;

    let decision = resolveAssemblyDrawerWheelInteraction({
      deltaX: 3,
      deltaY: 42,
      target: nestedTarget,
      lock,
      nowMs: 1000,
    });
    lock = decision.lock;

    expect(decision.action).toBe('vertical-scroll');
    expect(lock?.axis).toBe('vertical');

    decision = resolveAssemblyDrawerWheelInteraction({
      deltaX: 31,
      deltaY: 0,
      target: nestedTarget,
      lock,
      nowMs: 1075,
    });

    expect(decision.action).toBe('vertical-scroll');

    decision = resolveAssemblyDrawerWheelInteraction({
      deltaX: 31,
      deltaY: 0,
      target: nestedTarget,
      lock: decision.lock,
      nowMs: 1400,
    });

    expect(decision.action).toBe('horizontal-scroll');
    expect(decision.lock?.axis).toBe('horizontal');
  });

  it('locks a trackpad burst to horizontal and suppresses later vertical-only drift', () => {
    const nestedTarget = horizontalScrollTarget();
    let decision = resolveAssemblyDrawerWheelInteraction({
      deltaX: 32,
      deltaY: 2,
      target: nestedTarget,
      lock: null,
      nowMs: 2000,
    });

    expect(decision.action).toBe('horizontal-scroll');
    expect(decision.lock?.axis).toBe('horizontal');

    decision = resolveAssemblyDrawerWheelInteraction({
      deltaX: 0,
      deltaY: 28,
      target: nestedTarget,
      lock: decision.lock,
      nowMs: 2050,
    });

    expect(decision.action).toBe('suppress');
    expect(decision.lock?.axis).toBe('horizontal');
  });

  it('renders three drawer steps', () => {
    const design = minimalDesign();
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
      pendingDispatchId: null,
    });

    render(<AssemblyPanelContent designId={design.id} />);

    expect(screen.queryByTestId('assembly-drawer-index')).toBeNull();
    expect(screen.getByTestId('assembly-drawer-step-title-parts')).toHaveTextContent('Parts');
    expect(screen.getByTestId('assembly-drawer-step-title-assembly')).toHaveTextContent('Assembly');
    expect(screen.queryByTestId('assembly-drawer-step-title-optimize')).toBeNull();
    expect(screen.getByTestId('assembly-drawer-step-title-export')).toHaveTextContent(
      'Finalize and Export'
    );
    for (const stepId of ['parts', 'assembly', 'export']) {
      expect(screen.getByTestId(`assembly-drawer-step-title-${stepId}`)).toHaveClass('text-xl');
    }
    expect(screen.getByTestId('assembly-drawer-step-title-parts')).not.toHaveClass('sticky');
    expect(screen.queryByRole('button', { name: /optimization/i })).toBeNull();
  });
});

describe('assembly method selection in the drawer', () => {
  function seed(design: SequenceDesign): void {
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
      pendingDispatchId: null,
    });
  }

  it('orders setup before parts, then review and finalization, without duplicate type controls', () => {
    const design = minimalDesign();
    seed(design);
    render(<AssemblyPanelContent designId={design.id} />);

    const parts = screen.getByTestId('assembly-drawer-step-body-parts');
    expect(within(parts).getByText('Cloning method')).toBeInTheDocument();
    const type = within(parts).getByTestId('assembly-method-select');
    const kit = within(parts).getByRole('combobox', { name: 'Assembly kit' });
    const empty = within(parts).getByTestId('assembly-empty-parts-cue');
    expect(type.compareDocumentPosition(kit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(kit.compareDocumentPosition(empty) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByTestId('assembly-method-select')).toHaveLength(1);
    expect(screen.queryByRole('combobox', { name: 'Assembly schema' })).toBeNull();
    expect(within(parts).queryByTestId('draft-assembly-button')).toBeNull();
    expect(
      within(screen.getByTestId('assembly-drawer-step-body-assembly')).queryByTestId(
        'assembly-method-select'
      )
    ).toBeNull();
  });

  it('mounts the assembly-method selector inside the drawer', () => {
    const design = minimalDesign();
    seed(design);

    render(<AssemblyPanelContent designId={design.id} />);

    const section = screen.getByTestId('assembly-method-section');
    expect(section).toBeInTheDocument();
    expect(within(section).getByTestId('assembly-method-select')).toHaveAttribute(
      'data-value',
      'goldengate'
    );
  });

  it('keeps the Golden Gate enzyme selector enabled when RD fragments are present', () => {
    const design: SequenceDesign = {
      ...minimalDesign(),
      regions: [
        {
          id: 'rd',
          sourceSequenceId: 's',
          sourceSequenceName: 'RD',
          sourceStart: 0,
          sourceEnd: 16,
          sequence: 'AAAACCCCGGGGGCTA',
          annotations: [],
          sourceType: 'rd',
          ggType: 'insert',
          rdSourceEnzyme: 'BsaI',
          rdSourceEnzymeName: 'BsaI',
          rdOverhangs: { upstream: 'AATG', downstream: 'GCTA' },
        },
      ],
    };
    seed(design);

    render(<AssemblyPanelContent designId={design.id} />);

    const enzymeSelect = within(screen.getByTestId('assembly-method-section')).getByTestId(
      'assembly-enzyme-select'
    );
    expect(enzymeSelect).toHaveAttribute('data-value', 'BsaI');
    expect(enzymeSelect).not.toBeDisabled();
  });

  it('switching the method from the drawer drives setAssemblyMethod', () => {
    const design: SequenceDesign = { ...minimalDesign(), assemblyMethod: 'gibson' };
    seed(design);

    render(<AssemblyPanelContent designId={design.id} />);

    const methodSelect = within(screen.getByTestId('assembly-method-section')).getByTestId(
      'assembly-method-select'
    );
    fireEvent.click(methodSelect);
    fireEvent.click(screen.getByTestId('assembly-method-option-goldengate'));

    expect(useDesignStore.getState().designs[design.id].assemblyMethod).toBe('goldengate');
  });

  it('mounts the shared PCR Tm configurator and writes the design polymerase', () => {
    const design: SequenceDesign = {
      ...minimalDesign(),
      regions: [
        {
          id: 'pcr-part',
          sourceSequenceId: 'source',
          sourceSequenceName: 'PCR part',
          sourceStart: 0,
          sourceEnd: 4,
          sequence: 'ATGC',
          annotations: [],
          sourceType: 'pcr',
        },
      ],
    };
    seed(design);
    useSettingsStore.setState({ tmModel: DEFAULT_TM_MODEL, tmModelExplicit: false });

    render(<AssemblyPanelContent designId={design.id} />);

    const configurator = screen.getByTestId('assembly-pcr-tm-configurator');
    expect(configurator).toBeInTheDocument();
    expect(within(configurator).getByTestId('tm-model-select')).toBeInTheDocument();
    expect(screen.queryByTestId('tm-primer-conc')).toBeNull();
    expect(screen.queryByTestId('assembly-workbench-default-pcr-tm')).toBeNull();

    fireEvent.click(within(configurator).getByTestId('assembly-pcr-mix-settings'));
    expect(screen.getByTestId('assembly-pcr-mix-settings-panel')).toHaveAttribute(
      'data-placement',
      'below'
    );
    expect(screen.getByTestId('tm-primer-conc')).toBeInTheDocument();
    expect(screen.getByTestId('assembly-workbench-default-pcr-tm')).toBeInTheDocument();

    const modelSelect = within(configurator).getByTestId('tm-model-select');
    fireEvent.mouseDown(modelSelect);
    expect(screen.queryByTestId('assembly-pcr-mix-settings-panel')).not.toBeInTheDocument();
    fireEvent.click(modelSelect);
    fireEvent.click(screen.getByTestId('tm-model-select-option-q5-0'));

    expect(useSettingsStore.getState().tmModel).toEqual({
      kind: 'neb',
      prodcode: 'q5-0',
      polymerase: 'q5',
    });
    expect(useDesignStore.getState().designs[design.id].pcrPolymerase).toBe('q5-0');
  });

  it('keeps unavailable draft verbs out of the assembly toolbar', () => {
    const design = minimalDesign();
    seed(design);

    render(<AssemblyPanelContent designId={design.id} />);

    const plate = screen.getByTestId('assembly-review-controls');
    expect(within(plate).queryByTestId('assembly-method-select')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tm-model-select')).not.toBeInTheDocument();
    expect(screen.queryByTestId('assembly-pcr-mix-settings')).not.toBeInTheDocument();
    expect(within(plate).queryByTestId('draft-assembly-button')).not.toBeInTheDocument();
    expect(within(plate).queryByTestId('clear-assembly-draft-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tm-primer-conc')).toBeNull();
    expect(screen.queryByTestId('assembly-card-view-toggle')).toBeNull();

    const workbench = screen.getByTestId('junction-workbench');
    expect(within(workbench).getByTestId('assembly-construct-bar')).toBeInTheDocument();
  });
});

function horizontalScrollTarget(): HTMLElement {
  const horizontalViewer = document.createElement('div');
  horizontalViewer.dataset.assemblyHorizontalScroll = 'true';
  const nestedTarget = document.createElement('div');
  horizontalViewer.appendChild(nestedTarget);
  return nestedTarget;
}

function minimalDesign(): SequenceDesign {
  const now = new Date('2026-05-18T00:00:00.000Z');
  return {
    id: 'assembly-panel-design',
    name: 'Assembly panel design',
    topology: 'circular',
    regions: [],
    spacers: [],
    version: 1,
    assemblyState: 'ready',
    validationErrors: [],
    proposedPlans: [],
    status: 'computed',
    assemblyMethod: 'goldengate',
    goldenGateConfig: { enzyme: 'BsaI' },
    goldenGateJunctions: [],
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
