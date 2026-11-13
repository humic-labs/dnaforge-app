/**
 * @vitest-environment jsdom
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeDraftAssembly } from '../design/algorithms/draft-assembly';
import type { DesignPrimer, DesignRegion, HomologyRegion, SequenceDesign } from '../design/types';
import { useDesignStore } from '../design/store';
import { useCanvasStore } from '../canvas/store';
import {
  JunctionWorkbench,
  LIVE_FIELD_VALUE_STORE_SCHEMA_VERSION,
  ensureLiveFieldValueStoreForTesting,
  liveFieldValueStoreCompatibilityForTesting,
} from './JunctionWorkbench';
import {
  applyAssemblyWorkbenchCommand,
  createAssemblyWorkbenchViewState,
} from './AssemblyWorkbenchReducer';
import type { AssemblyWorkbenchLiveFieldPreview } from './AssemblyWorkbenchContract';
import {
  clearGoldenGateAutoOptimizationCacheForTesting,
  planGoldenGateAutoOptimization,
  setGoldenGateExactSearchNodeLimitForTesting,
} from './AssemblyWorkbenchAutoOptimizer';
import { validateGoldenGateAssembly } from '../design/validation/golden-gate-overhangs';
import { buildAssemblyOptimizationInput } from '../assembly/assembly-optimization-input';

const mockModels = vi.hoisted(() => [
  {
    id: 'mock-junction-0',
    junctionIndex: 0,
    method: 'gibson',
    editable: true,
    mapping: {},
    rows: [
      { id: 'gibson-0-left', kind: 'left-source', sequence: 'A'.repeat(24) },
      { id: 'gibson-0-product', kind: 'product', sequence: 'C'.repeat(24) },
      { id: 'gibson-0-right', kind: 'right-source', sequence: 'G'.repeat(24) },
    ],
  },
]);

vi.mock('./model', () => ({
  buildJunctionWorkbenchModels: vi.fn((design: SequenceDesign) => {
    const goldenGateJunctions = design.goldenGateJunctions ?? [];
    if (design.assemblyMethod === 'goldengate' && goldenGateJunctions.length === 0) {
      return [];
    }
    if (design.assemblyMethod !== 'goldengate' && design.homologyRegions.length === 0) {
      return [];
    }
    if (goldenGateJunctions.length === 0) {
      return mockModels.map((model) => ({
        ...model,
        homologyRegion: design.homologyRegions.find(
          (homology) => homology.junctionIndex === model.junctionIndex
        ),
      }));
    }
    return goldenGateJunctions.map((junction) => ({
      id: `mock-junction-${junction.junctionIndex}`,
      junctionIndex: junction.junctionIndex,
      method: design.assemblyMethod,
      editable: true,
      mapping: {},
      goldenGateJunction: junction,
      rows: [
        {
          id: `mock-junction-${junction.junctionIndex}-left`,
          kind: 'left-source',
          sequence: 'L'.repeat(12),
        },
        {
          id: `mock-junction-${junction.junctionIndex}-product`,
          kind: 'product',
          sequence: junction.overhang,
        },
        {
          id: `mock-junction-${junction.junctionIndex}-right`,
          kind: 'right-source',
          sequence: 'R'.repeat(12),
        },
      ],
    }));
  }),
  applyOverrideToCanonicalModels: vi.fn((models) => models),
}));

vi.mock('./RegisteredAssemblyViewport', () => ({
  RegisteredAssemblyViewport: ({
    rows = [],
    productControls,
    editableFields = [],
    onFieldLivePreview,
    onFieldLivePreviewEnd,
    onFieldPreview,
  }: {
    rows?: Array<{ id: string; kind: string; sequence: string }>;
    productControls?: ReactNode;
    editableFields?: Array<{
      id: string;
      disabled?: boolean;
      kind: string;
      value: number;
      target: {
        fragmentIndex?: number;
        junctionIndex?: number;
        direction?: string;
        side?: string;
      };
    }>;
    onFieldLivePreview?: (
      field: (typeof editableFields)[number],
      preview: AssemblyWorkbenchLiveFieldPreview
    ) => void;
    onFieldLivePreviewEnd?: () => void;
    onFieldPreview?: (field: (typeof editableFields)[number], nextValue: number) => void;
  }) => (
    <div data-testid="mock-registered-assembly-viewport">
      {rows
        .filter((row) => row.kind === 'product')
        .map((row) => (
          <div
            key={row.id}
            data-testid={`mock-product-row-${row.id}`}
            data-product-row-sequence={row.sequence}
          >
            {row.sequence}
          </div>
        ))}
      {productControls}
      {editableFields.map((field) => (
        <button
          key={field.id}
          type="button"
          disabled={field.disabled}
          data-testid={`mock-live-field-${field.kind}-${
            field.target.fragmentIndex ?? field.target.junctionIndex ?? 'junction'
          }-${field.target.direction ?? field.target.side ?? 'none'}`}
          onMouseDown={() => onFieldLivePreview?.(field, livePreviewForMockField(field))}
          onMouseUp={() => onFieldLivePreviewEnd?.()}
        >
          Live {field.kind}
        </button>
      ))}
      {editableFields.map((field) => (
        <button
          key={`preview-${field.id}`}
          type="button"
          disabled={field.disabled}
          data-testid={`mock-field-preview-${field.kind}-${
            field.target.fragmentIndex ?? field.target.junctionIndex ?? 'junction'
          }-${field.target.direction ?? field.target.side ?? 'none'}`}
          onClick={() => onFieldPreview?.(field, field.value + 1)}
        >
          Preview {field.kind}
        </button>
      ))}
    </div>
  ),
}));

function livePreviewForMockField(field: {
  kind: string;
  value: number;
  target: {
    primerId?: string;
    fragmentIndex?: number;
    junctionIndex?: number;
    direction?: string;
  };
}): AssemblyWorkbenchLiveFieldPreview {
  const preview: AssemblyWorkbenchLiveFieldPreview = { value: field.value + 2 };
  if (field.kind === 'primerPbs' && field.target.direction) {
    preview.primerTms = [
      {
        primerId: field.target.primerId,
        fragmentIndex: field.target.fragmentIndex,
        direction: field.target.direction as 'forward' | 'reverse',
        tm: 63.7,
      },
    ];
  }
  if (field.kind === 'homologyArm') {
    preview.homologyTm = {
      junctionIndex: field.target.junctionIndex ?? 0,
      tm: 55.5,
    };
  }
  return preview;
}

vi.mock('./LinkedCameraGroup', () => ({
  LinkedCameraGroup: ({ productControls }: { productControls?: ReactNode }) => (
    <div data-testid="mock-linked-camera-group">{productControls}</div>
  ),
}));

vi.mock('./SourceContextRegistry', () => ({
  SourceContextRegistry: class {
    resolveWindows() {
      return {};
    }
    unresolvedRequests() {
      return [];
    }
  },
  createAssemblyWorkbenchSourceContext: () => ({ ready: true, regions: {}, sources: {} }),
  createJunctionSourceWindowRequests: () => [],
  loadAllSourceSequencesFromDb: vi.fn(async () => ({})),
  loadSourceSequenceForKey: vi.fn(async () => null),
  sourceLookupKeys: () => [],
}));

describe('JunctionWorkbench chrome', () => {
  beforeEach(() => {
    useCanvasStore.getState().reset();
    clearGoldenGateAutoOptimizationCacheForTesting();
    setGoldenGateExactSearchNodeLimitForTesting(null);
    useDesignStore.setState({
      designs: {},
      activeDesignId: null,
      pendingDispatchId: null,
    });
  });

  it.each(['gibson', 'goldengate'] as const)(
    'shows saved %s junctions read-only without registering or editing a draft',
    (method) => {
      const design = method === 'gibson' ? baseDraftedDesign() : draftedCircularGoldenGateDesign();
      const original = JSON.stringify(design);
      render(<JunctionWorkbench design={design} readOnly />);
      const workbench = screen.getByTestId('junction-workbench');
      expect(workbench).toHaveAttribute('data-read-only', 'true');
      expect(screen.getAllByTestId('junction-workbench-card').length).toBeGreaterThan(0);
      expect(screen.queryByTestId('assembly-pcr-tm-configurator')).not.toBeInTheDocument();
      expect(screen.queryByTestId('assembly-review-controls')).not.toBeInTheDocument();
      expect(workbench.querySelector('input, textarea, select')).toBeNull();
      for (const field of workbench.querySelectorAll('[data-testid^="mock-live-field-"]'))
        expect(field).toBeDisabled();
      expect(screen.queryByTestId('assembly-workbench-auto-optimize')).not.toBeInTheDocument();
      expect(workbench).toHaveAttribute('data-workbench-commit-command-count', '0');
      expect(useDesignStore.getState().designs).toEqual({});
      expect(JSON.stringify(design)).toBe(original);
    }
  );

  it.each(['empty', 'digest', 'mixed', 'pcr'] as const)(
    'shows PCR settings only for relevant inputs: %s',
    (kind) => {
      const design = baseDesign('goldengate');
      design.regions = design.regions.map((part, index) =>
        kind === 'empty'
          ? { ...part, sequence: '', isPlaceholder: true }
          : {
              ...part,
              sourceType: kind === 'digest' || (kind === 'mixed' && index === 0) ? 'rd' : 'pcr',
            }
      );
      render(<JunctionWorkbench design={design} />);
      expect(Boolean(screen.queryByTestId('assembly-pcr-tm-configurator'))).toBe(
        kind === 'mixed' || kind === 'pcr'
      );
      expect(screen.queryByTestId('assembly-method-select')).not.toBeInTheDocument();
      expect(screen.queryByTestId('assembly-enzyme-select')).not.toBeInTheDocument();
    }
  );

  it('renders junction cards locally without the deferred PCR-product selector', () => {
    const design = draftedCircularGoldenGateDesign();
    const rendered = render(<JunctionWorkbench design={design} />);

    expect(
      rendered.container.querySelectorAll('[data-testid="junction-workbench-card"]')
    ).toHaveLength(2);
    expect(screen.queryByTestId('assembly-card-view-toggle')).not.toBeInTheDocument();
    expect(screen.queryByTestId('assembly-pcr-product-list')).not.toBeInTheDocument();
    expect(rendered.container.querySelector('[data-assembly-inline-story-kind]')).toBeNull();
    expect(screen.queryByTestId('assembly-workbench-story-part-0')).not.toBeInTheDocument();
    expect(screen.queryByTestId('assembly-workbench-story-part-1')).not.toBeInTheDocument();
  });

  it('removes the deprecated session overview while keeping junction findings visible', () => {
    const design = draftedDesignWithHomologyLengthWarning();

    render(<JunctionWorkbench design={design} />);

    expect(screen.queryByTestId('assembly-workbench-session')).not.toBeInTheDocument();
    expect(screen.queryByTestId('assembly-workbench-mode-gibson')).not.toBeInTheDocument();
    expect(screen.queryByTestId('assembly-workbench-junction-0')).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('assembly-workbench-selected-junction-summary')
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId('assembly-workbench-global-issues')).not.toBeInTheDocument();

    expect(screen.queryByTestId('assembly-workbench-junction-issues-0')).not.toBeInTheDocument();
    expect(screen.getByTestId('junction-workbench-card')).toHaveAttribute(
      'data-issue-severity',
      'warning'
    );
    expect(screen.getByTestId('junction-workbench-card')).toHaveClass('border-orange-300/80');
    expect(screen.getByTestId('junction-workbench-card')).toHaveClass('ring-1');
    expect(screen.getByTestId('junction-workbench-card')).toHaveAttribute(
      'title',
      expect.stringContaining('preferred range')
    );
    expect(screen.getByTestId('junction-workbench-card')).toContainElement(
      screen.getByTestId('junction-workbench-card-accent-rail')
    );
    expect(screen.getByTestId('assembly-workbench-homology-control-0')).toHaveAttribute(
      'data-local-issue-severity',
      'warning'
    );
    expect(screen.getByTestId('assembly-workbench-homology-control-0')).toHaveAttribute(
      'title',
      expect.stringContaining('preferred range')
    );
    expect(screen.getByTestId('assembly-workbench-bottom-warning-summary')).toHaveTextContent(
      '1 warning'
    );
    expect(screen.getByTestId('assembly-workbench-bottom-warning-summary')).toHaveTextContent(
      'Homology length is outside the preferred range'
    );
    expect(screen.getByTestId('mock-registered-assembly-viewport')).toContainElement(
      screen.getByTestId('product-row-junction-controls-0')
    );
    expect(screen.getByTestId('product-row-junction-controls-0')).not.toHaveTextContent('Spacer');
    expect(screen.getByTestId('product-row-junction-controls-0')).not.toHaveTextContent(
      'Homology length is outside the preferred range'
    );
    const autoOptimize = screen.getByTestId('assembly-workbench-auto-optimize');
    expect(autoOptimize).toBeVisible();
    expect(screen.getByTestId('assembly-workbench-optimize')).toHaveAttribute(
      'data-kind',
      'homology-one-click'
    );
    expect(screen.queryByTestId('assembly-workbench-goldengate-optimizer-run')).toBeNull();
    expectOptimizeSlotAbovePrimerCards();
  });

  it('surfaces overlap and primer annealing temperatures in compact workbench controls', () => {
    const design = draftedDesignWithTemperatureReadouts();

    render(<JunctionWorkbench design={design} />);

    expect(screen.getByTestId('assembly-workbench-temperature-summary')).toHaveTextContent(
      'overlap47.6–49.0°C'
    );
    expect(screen.getByTestId('assembly-workbench-temperature-summary')).toHaveTextContent(
      'anneal58.4–61.2°C'
    );
    expect(screen.queryByTestId('assembly-workbench-default-pcr-tm')).toBeNull();
    expect(screen.queryByTestId('assembly-card-view-toggle')).toBeNull();
    expect(screen.getByTestId('assembly-review-controls')).toContainElement(
      screen.getByTestId('tm-model-select')
    );
    expect(screen.getByTestId('junction-workbench-card')).toBeInTheDocument();
    expect(screen.getByTestId('assembly-workbench-homology-tm-0')).toHaveTextContent('47.6 C');
    expect(screen.getByTestId('assembly-workbench-homology-summary-0')).toHaveTextContent(
      'Overlap'
    );
    expect(screen.getByTestId('assembly-workbench-homology-summary-0')).toContainElement(
      screen.getByTestId('assembly-workbench-homology-tm-0')
    );
    expect(screen.getByTestId('assembly-workbench-primer-tm-0-reverse')).toHaveTextContent(
      '58.4 C'
    );
    expect(screen.getByTestId('assembly-workbench-primer-tm-1-forward')).toHaveTextContent(
      '61.2 C'
    );
    expect(screen.getByTestId('assembly-workbench-primer-pbs-0-reverse')).toHaveValue(20);
    expect(screen.getByTestId('assembly-workbench-primer-pbs-0-reverse-control')).toHaveAttribute(
      'data-number-control-label',
      'PBS'
    );
    expect(screen.getByTestId('product-row-junction-controls-0')).not.toHaveTextContent('Tail');
    expect(screen.queryByTestId('assembly-workbench-primer-overhang-0-reverse')).toBeNull();
    expect(screen.queryByTestId('assembly-workbench-primer-overhang-1-forward')).toBeNull();
  });

  it('jumps from the junction card to the corresponding design sequence viewer position', () => {
    const design = draftedDesignWithoutFindings();
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
      pendingDispatchId: null,
    });
    const tabId = useCanvasStore.getState().openTab('main', {
      type: 'design',
      entityId: design.id,
      label: design.name,
    });

    render(<JunctionWorkbench design={design} />);

    const jumpButton = screen.getByTestId('assembly-workbench-junction-jump-0');
    expect(jumpButton).toBeVisible();
    expect(jumpButton).toHaveAccessibleName('Jump J1 in sequence viewer');
    fireEvent.click(jumpButton);

    expect(useDesignStore.getState().designs[design.id].scrollToPosition).toBe(
      design.homologyRegions[0].junctionPosition
    );
    expect(useCanvasStore.getState().panels.main.activeTabId).toBe(tabId);
  });

  it('skips applyWorkbenchCommand for sourceContributionBoundary previews — C6 invariant  perf)', async () => {
    vi.useFakeTimers();
    try {
      const design = draftedDesignWithoutFindings();
      useDesignStore.setState({
        designs: { [design.id]: design },
        activeDesignId: design.id,
        pendingDispatchId: null,
      });

      render(<JunctionWorkbench design={design} />);

      const startVersion = useDesignStore.getState().designs[design.id].version;
      const workbench = screen.getByTestId('junction-workbench');
      const startCommitCount = Number(
        workbench.getAttribute('data-workbench-commit-command-count') ?? '0'
      );

      const sourcePreviewButton = screen.queryAllByTestId(
        /^mock-field-preview-sourceContributionBoundary-/
      )[0];
      expect(sourcePreviewButton).toBeDefined();
      if (!sourcePreviewButton) throw new Error('source-boundary preview button missing');

      fireEvent.click(sourcePreviewButton);

      act(() => {
        vi.advanceTimersByTime(100);
      });

      const afterVersion = useDesignStore.getState().designs[design.id].version;
      const afterCommitCount = Number(
        workbench.getAttribute('data-workbench-commit-command-count') ?? '0'
      );

      expect(afterVersion).toBe(startVersion);
      expect(afterCommitCount).toBe(startCommitCount);

      expect(workbench.getAttribute('data-workbench-preview-active')).toBe('false');
    } finally {
      vi.useRealTimers();
    }
  });

  it('commits PBS length after a spinner-style change WITHOUT an explicit blur (regression for live-app bug)', async () => {
    vi.useFakeTimers();
    try {
      const design = draftedDesignWithoutFindings();
      useDesignStore.setState({
        designs: { [design.id]: design },
        activeDesignId: design.id,
        pendingDispatchId: null,
      });

      render(<JunctionWorkbench design={design} />);

      const pbsInput = screen.getByTestId(
        'assembly-workbench-primer-pbs-0-reverse'
      ) as HTMLInputElement;
      expect(pbsInput.value).toBe('20');

      fireEvent.change(pbsInput, { target: { value: '25' } });

      expect(pbsInput.value).toBe('25');

      const pbsLengthFor = (designSnapshot: typeof design): number | null => {
        const primer = designSnapshot.designPrimers.find(
          (pair) => pair.reverse.fragmentIndex === 0
        )?.reverse;
        return primer ? primer.pbs.end - primer.pbs.start : null;
      };

      act(() => {
        vi.advanceTimersByTime(100);
      });
      const midway = useDesignStore.getState().designs[design.id];
      expect(pbsLengthFor(midway)).toBe(20);

      act(() => {
        vi.advanceTimersByTime(500);
      });
      const committed = useDesignStore.getState().designs[design.id];
      expect(pbsLengthFor(committed)).toBe(25);
      expect(committed.version).toBeGreaterThan(design.version);
      expect(pbsInput.value).toBe('25');
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels pending auto-commit when user presses Escape after a spinner click  edge case)', async () => {
    vi.useFakeTimers();
    try {
      const design = draftedDesignWithoutFindings();
      useDesignStore.setState({
        designs: { [design.id]: design },
        activeDesignId: design.id,
        pendingDispatchId: null,
      });

      render(<JunctionWorkbench design={design} />);

      const pbsInput = screen.getByTestId(
        'assembly-workbench-primer-pbs-0-reverse'
      ) as HTMLInputElement;
      expect(pbsInput.value).toBe('20');
      const startVersion = useDesignStore.getState().designs[design.id].version;

      fireEvent.change(pbsInput, { target: { value: '30' } });
      expect(pbsInput.value).toBe('30');
      fireEvent.keyDown(pbsInput, { key: 'Escape' });

      expect(pbsInput.value).toBe('20');

      act(() => {
        vi.advanceTimersByTime(500);
      });

      const after = useDesignStore.getState().designs[design.id];
      expect(after.version).toBe(startVersion);
      expect(pbsInput.value).toBe('20');
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels pending PBS auto-commit when an external value lands mid-debounce  race)', async () => {
    vi.useFakeTimers();
    try {
      const design = draftedDesignWithoutFindings();
      useDesignStore.setState({
        designs: { [design.id]: design },
        activeDesignId: design.id,
        pendingDispatchId: null,
      });

      render(<JunctionWorkbench design={design} />);

      const pbsInput = screen.getByTestId(
        'assembly-workbench-primer-pbs-0-reverse'
      ) as HTMLInputElement;
      expect(pbsInput.value).toBe('20');

      fireEvent.change(pbsInput, { target: { value: '25' } });
      expect(pbsInput.value).toBe('25');

      act(() => {
        vi.advanceTimersByTime(100);
      });
      act(() => {
        const current = useDesignStore.getState().designs[design.id];
        const externalDesign: typeof current = {
          ...current,
          version: current.version + 1,
          designPrimers: current.designPrimers.map((pair) =>
            pair.reverse.fragmentIndex === 0
              ? {
                  ...pair,
                  reverse: {
                    ...pair.reverse,
                    pbs: { ...pair.reverse.pbs, end: pair.reverse.pbs.start + 40 },
                  },
                }
              : pair
          ),
        };
        useDesignStore.setState({
          designs: { ...useDesignStore.getState().designs, [design.id]: externalDesign },
        });
      });

      const externalCommitVersion = useDesignStore.getState().designs[design.id].version;

      act(() => {
        vi.advanceTimersByTime(500);
      });

      const after = useDesignStore.getState().designs[design.id];
      expect(after.version).toBe(externalCommitVersion);
      const primer = after.designPrimers.find((pair) => pair.reverse.fragmentIndex === 0)?.reverse;
      const pbsLength = primer ? primer.pbs.end - primer.pbs.start : null;
      expect(pbsLength).toBe(40);
    } finally {
      vi.useRealTimers();
    }
  });

  it('debounces rapid spinner clicks so only the last value commits  edge case)', async () => {
    vi.useFakeTimers();
    try {
      const design = draftedDesignWithoutFindings();
      useDesignStore.setState({
        designs: { [design.id]: design },
        activeDesignId: design.id,
        pendingDispatchId: null,
      });

      render(<JunctionWorkbench design={design} />);

      const pbsInput = screen.getByTestId(
        'assembly-workbench-primer-pbs-0-reverse'
      ) as HTMLInputElement;
      const startVersion = useDesignStore.getState().designs[design.id].version;

      fireEvent.change(pbsInput, { target: { value: '23' } });
      act(() => {
        vi.advanceTimersByTime(100);
      });

      fireEvent.change(pbsInput, { target: { value: '27' } });
      act(() => {
        vi.advanceTimersByTime(500);
      });

      const committed = useDesignStore.getState().designs[design.id];
      expect(committed.version).toBe(startVersion + 1);
      const primer = committed.designPrimers.find(
        (pair) => pair.reverse.fragmentIndex === 0
      )?.reverse;
      const pbsLength = primer ? primer.pbs.end - primer.pbs.start : null;
      expect(pbsLength).toBe(27);
    } finally {
      vi.useRealTimers();
    }
  });

  it('commits PBS length when the user types into the number input and blurs  regression probe)', () => {
    const design = draftedDesignWithoutFindings();
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
      pendingDispatchId: null,
    });

    render(<JunctionWorkbench design={design} />);

    const pbsInput = screen.getByTestId(
      'assembly-workbench-primer-pbs-0-reverse'
    ) as HTMLInputElement;
    expect(pbsInput).toHaveValue(20);

    const reversePrimerBefore = design.designPrimers.find(
      (pair) => pair.reverse.fragmentIndex === 0 && pair.reverse.direction === 'reverse'
    )?.reverse;
    expect(reversePrimerBefore).toBeDefined();
    const reversePrimerPbsBefore = reversePrimerBefore
      ? reversePrimerBefore.pbs.end - reversePrimerBefore.pbs.start
      : null;
    expect(reversePrimerPbsBefore).toBe(20);

    fireEvent.change(pbsInput, { target: { value: '25' } });
    expect(pbsInput).toHaveValue(25);

    fireEvent.blur(pbsInput);

    const committed = useDesignStore.getState().designs[design.id];
    const reversePrimerAfter = committed.designPrimers.find(
      (pair) => pair.reverse.fragmentIndex === 0 && pair.reverse.direction === 'reverse'
    )?.reverse;
    expect(reversePrimerAfter).toBeDefined();
    const reversePrimerPbsAfter = reversePrimerAfter
      ? reversePrimerAfter.pbs.end - reversePrimerAfter.pbs.start
      : null;
    expect(reversePrimerPbsAfter).toBe(25);
    expect(committed.version).toBeGreaterThan(design.version);

    expect(pbsInput).toHaveValue(25);
  });

  it('live-updates compact primer PBS numbers during handle drag preview without semantic preview state', () => {
    const design = draftedDesignWithoutFindings();

    render(<JunctionWorkbench design={design} />);

    const pbsInput = screen.getByTestId('assembly-workbench-primer-pbs-0-reverse');
    const primerTm = screen.getByTestId('assembly-workbench-primer-tm-0-reverse');
    expect(pbsInput).toHaveValue(20);
    expect(primerTm).not.toHaveTextContent('63.7 C');
    expect(screen.getByTestId('junction-workbench')).toHaveAttribute(
      'data-workbench-preview-active',
      'false'
    );

    fireEvent.mouseDown(screen.getByTestId('mock-live-field-primerPbs-0-reverse'));

    expect(pbsInput).toHaveValue(22);
    expect(primerTm).toHaveTextContent('63.7 C');
    expect(screen.getByTestId('junction-workbench')).toHaveAttribute(
      'data-workbench-preview-active',
      'false'
    );

    fireEvent.mouseUp(screen.getByTestId('mock-live-field-primerPbs-0-reverse'));

    expect(pbsInput).toHaveValue(20);
    expect(primerTm).not.toHaveTextContent('63.7 C');
  });

  it('live-updates compact homology Tm during overlap drag preview without semantic preview state', () => {
    const design = draftedDesignWithoutFindings();

    render(<JunctionWorkbench design={design} />);

    expect(screen.getByTestId('assembly-workbench-homology-tm-0')).toHaveTextContent('50.0 C');
    expect(screen.getByTestId('assembly-workbench-temperature-summary')).toHaveTextContent(
      'overlap50.0°C'
    );

    fireEvent.mouseDown(screen.getByTestId('mock-live-field-homologyArm-0-left'));

    expect(screen.getByTestId('assembly-workbench-homology-tm-0')).toHaveTextContent('55.5 C');
    expect(screen.getByTestId('assembly-workbench-temperature-summary')).toHaveTextContent(
      'overlap50.0–55.5°C'
    );
    expect(screen.getByTestId('junction-workbench')).toHaveAttribute(
      'data-workbench-preview-active',
      'false'
    );

    fireEvent.mouseUp(screen.getByTestId('mock-live-field-homologyArm-0-left'));

    expect(screen.getByTestId('assembly-workbench-homology-tm-0')).toHaveTextContent('50.0 C');
  });

  it('attributes primer PBS warnings to the exact primer control without gutter warning text', () => {
    const design = draftedDesignWithPrimerWarning();

    render(<JunctionWorkbench design={design} />);

    expect(screen.getByTestId('assembly-workbench-primer-control-0-reverse')).toHaveAttribute(
      'data-local-issue-severity',
      'warning'
    );
    expect(screen.getByTestId('assembly-workbench-primer-control-0-reverse')).toHaveAttribute(
      'title',
      expect.stringContaining('preferred range')
    );
    expect(screen.getByTestId('product-row-junction-controls-0')).not.toHaveTextContent(
      'Primer binding length is outside'
    );
    expect(screen.getByTestId('assembly-workbench-bottom-warning-summary')).toHaveTextContent(
      'Primer binding length is outside the preferred range'
    );
  });

  it('disables the constrained overlap number box for RD/PCR Gibson junctions', () => {
    const design = draftedRdAdjacentHomologyDesign('left');

    render(<JunctionWorkbench design={design} />);

    expect(screen.getByTestId('assembly-workbench-homology-left-0')).toBeEnabled();
    expect(screen.getByTestId('assembly-workbench-homology-right-0')).toBeDisabled();
  });

  it('omits issue chrome when there are no actionable problems', () => {
    const design = draftedDesignWithoutFindings();

    render(<JunctionWorkbench design={design} />);

    expect(screen.queryByTestId('assembly-workbench-global-issues')).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('assembly-workbench-bottom-warning-summary')
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId('assembly-workbench-junction-issues-0')).not.toBeInTheDocument();
  });

  it('hides draft notes and the Golden Gate offset limit before real primers exist', () => {
    const design: SequenceDesign = {
      ...baseDesign('goldengate'),
      assemblyMethod: 'goldengate',
      goldenGateConfig: { enzyme: 'BsaI' },
      goldenGateJunctions: [],
      designPrimers: [],
    };

    render(<JunctionWorkbench design={design} />);

    expect(screen.queryByText('Draft Golden Gate assembly needed')).not.toBeInTheDocument();
    expect(screen.queryByTestId('assembly-workbench-global-issues')).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('assembly-workbench-bottom-warning-summary')
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('assembly-workbench-goldengate-offset-limit')
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId('junction-workbench-empty')).not.toBeInTheDocument();
    expect(screen.queryByText('No junction workbench data is available.')).not.toBeInTheDocument();
  });

  it('labels hard Golden Gate RD failures as errors instead of generic warnings', () => {
    const design: SequenceDesign = {
      ...baseDesign('goldengate'),
      assemblyMethod: 'goldengate',
      goldenGateConfig: { enzyme: 'BsaI' },
      goldenGateJunctions: [],
      regions: [
        {
          ...region('bsmBI-rd', 'ATCG'.repeat(60)),
          sourceType: 'rd' as const,
          ggType: 'insert',
          rdOverhangs: { upstream: 'AATG', downstream: 'GCTA' },
          rdSourceEnzyme: 'BsmBI' as const,
          rdSourceEnzymeName: 'BsmBI',
        },
        region('pcr', 'TGCA'.repeat(60)),
      ],
    };

    render(<JunctionWorkbench design={design} />);

    expect(screen.queryByTestId('assembly-workbench-global-issues')).not.toBeInTheDocument();
    expect(screen.getByTestId('assembly-workbench-bottom-warning-summary')).toHaveAttribute(
      'data-issue-severity',
      'error'
    );
    expect(
      screen.getByTestId('assembly-workbench-bottom-warning-summary').querySelector('summary')
    ).toHaveTextContent(/^1 error$/);
    expect(screen.getByTestId('assembly-workbench-bottom-warning-summary')).toHaveTextContent(
      'Incompatible RD enzyme'
    );
  });

  it('keeps internal Type IIS sites (a PART error) OUT of the Junctions workbench ', () => {
    const design: SequenceDesign = {
      ...baseDesign('goldengate'),
      assemblyMethod: 'goldengate',
      goldenGateConfig: { enzyme: 'BsaI' },
      goldenGateJunctions: [],
      regions: [
        region('pcr-internal', 'AAAACCCCGGTCTCAAAATTTTGGGG'.repeat(3)),
        region('pcr-clean', 'TGCA'.repeat(60)),
      ],
    };

    const validation = validateGoldenGateAssembly(design.regions, false, 'BsaI');
    expect(validation.conflicts.some((c) => c.type === 'internal-site')).toBe(true);

    render(<JunctionWorkbench design={design} />);

    expect(screen.queryByText('Enzyme site inside this part')).not.toBeInTheDocument();
  });

  it('rejects Fast Refresh-preserved legacy live-field stores that lack bulk preview support', () => {
    const legacyStore = {
      getValue: () => undefined,
      getHomologyTm: () => undefined,
      getPrimerTm: () => undefined,
      set: () => undefined,
      clear: () => undefined,
      subscribe: () => () => undefined,
      getSnapshot: () => 0,
    };

    expect(liveFieldValueStoreCompatibilityForTesting(legacyStore)).toEqual({
      compatible: false,
      schemaVersion: undefined,
      missingMethods: ['setMany'],
    });

    const replacement = ensureLiveFieldValueStoreForTesting(legacyStore) as {
      schemaVersion?: unknown;
      setMany?: unknown;
    };
    expect(replacement).not.toBe(legacyStore);
    expect(replacement.schemaVersion).toBe(LIVE_FIELD_VALUE_STORE_SCHEMA_VERSION);
    expect(typeof replacement.setMany).toBe('function');
    expect(ensureLiveFieldValueStoreForTesting(replacement)).toBe(replacement);
  });

  it('commits auto optimization through canonical workbench state', () => {
    const baseDesign = draftedDesignWithHomologyLengthWarning();
    const degraded = applyAssemblyWorkbenchCommand({
      design: baseDesign,
      viewState: createAssemblyWorkbenchViewState(baseDesign),
      command: {
        type: 'setHomologyEncoding',
        junctionIndex: 0,
        encoding: { onLeft: 1, onRight: 1 },
        expectedDesignVersion: baseDesign.version,
      },
    });
    expect(degraded.status).toBe('applied');
    const design = degraded.nextDesign;
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
      pendingDispatchId: null,
    });

    render(<JunctionWorkbench design={design} />);
    fireEvent.click(screen.getByTestId('assembly-workbench-auto-optimize'));

    const optimized = useDesignStore.getState().designs[design.id];
    const expectedDraft = computeDraftAssembly(design).homologyRegions[0];
    expect(optimized.version).toBe(design.version + 1);
    expect(optimized.homologyRegions[0].encoding).toEqual(expectedDraft.encoding);
    expect(optimized.homologyRegions[0].metadata?.sequence).toHaveLength(
      expectedDraft.metadata?.sequence.length ?? 0
    );
  });

  it('shows invalid Golden Gate overhang findings once in the warning details ', () => {
    const design = draftedGoldenGateOptimizerDesign();
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
      pendingDispatchId: null,
    });

    const invalidJunction = (design.goldenGateJunctions ?? []).find(
      (junction) => !junction.isValid
    );
    expect(invalidJunction).toBeDefined();
    if (!invalidJunction) throw new Error('Fixture must include an invalid junction');

    render(<JunctionWorkbench design={design} />);

    expect(screen.queryByTestId('assembly-workbench-global-issues')).not.toBeInTheDocument();
    const banner = screen.getByTestId('assembly-workbench-bottom-warning-summary');
    const summary = banner.querySelector('summary');
    expect(summary).toBeVisible();
    if (!summary) throw new Error('Expected the warning summary');
    fireEvent.click(summary);
    expect(banner).toHaveAttribute('open');
    expect(banner).toHaveAttribute('data-issue-severity', 'error');
    expect(banner).toHaveTextContent(`J${invalidJunction.junctionIndex + 1}`);
    expect(banner).toHaveTextContent('Invalid Golden Gate overhang');
    expect(invalidJunction.validationError).toBeTruthy();
    expect(banner).toHaveTextContent(invalidJunction.validationError ?? '');
  });

  it('collapses Golden Gate optimize chrome into one slot below the primer cards', () => {
    const design = draftedGoldenGateOptimizerDesign();
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
      pendingDispatchId: null,
    });

    render(<JunctionWorkbench design={design} />);

    expect(screen.queryByTestId('assembly-workbench-auto-optimize')).toBeNull();
    expect(screen.getByTestId('assembly-workbench-optimize')).toHaveAttribute(
      'data-kind',
      'goldengate-ranked'
    );
    expect(screen.getByTestId('assembly-workbench-goldengate-optimizer-run')).toBeVisible();
    expectOptimizeSlotAbovePrimerCards();

    fireEvent.click(screen.getByTestId('assembly-workbench-goldengate-optimizer-run'));
    const implicitBest = document.querySelector(
      '[data-implicit-best="true"]'
    ) as HTMLElement | null;
    expect(implicitBest).not.toBeNull();
    if (!implicitBest) throw new Error('Expected an implicit-best Golden Gate row');

    const overhangsBefore = (design.goldenGateJunctions ?? []).map((junction) => junction.overhang);
    fireEvent.click(implicitBest);
    fireEvent.click(screen.getByTestId('assembly-workbench-goldengate-optimizer-apply'));

    const optimized = useDesignStore.getState().designs[design.id];
    const overhangsAfter = (optimized.goldenGateJunctions ?? []).map(
      (junction) => junction.overhang
    );
    expect(optimized.version).toBe(design.version + 1);
    expect(overhangsAfter).not.toEqual(overhangsBefore);
    expect(screen.getByTestId('assembly-workbench-goldengate-optimizer')).toBeVisible();
  });

  it('replaces the optimize slot when the same workbench switches Gibson to Golden Gate', () => {
    const gibson = draftedDesignWithHomologyLengthWarning();
    const undraftedGoldenGate: SequenceDesign = {
      ...gibson,
      assemblyMethod: 'goldengate',
      homologyRegions: [],
      goldenGateJunctions: [],
      goldenGateConfig: { enzyme: 'BsaI' },
    };
    const draftedGoldenGate = draftedGoldenGateOptimizerDesign();

    const { rerender } = render(<JunctionWorkbench design={gibson} />);
    expect(screen.getByTestId('assembly-workbench-optimize')).toHaveAttribute(
      'data-kind',
      'homology-one-click'
    );
    expect(screen.getByTestId('assembly-workbench-auto-optimize')).toBeVisible();
    expect(screen.queryByTestId('assembly-workbench-goldengate-optimizer-run')).toBeNull();

    rerender(<JunctionWorkbench design={undraftedGoldenGate} />);
    expect(screen.queryByTestId('assembly-workbench-optimize')).toBeNull();
    expect(screen.queryByTestId('assembly-workbench-auto-optimize')).toBeNull();
    expect(screen.queryByTestId('assembly-workbench-goldengate-optimizer-run')).toBeNull();

    rerender(<JunctionWorkbench design={draftedGoldenGate} />);
    expect(screen.getByTestId('assembly-workbench-optimize')).toHaveAttribute(
      'data-kind',
      'goldengate-ranked'
    );
    expect(screen.queryByTestId('assembly-workbench-auto-optimize')).toBeNull();
    expect(screen.getByTestId('assembly-workbench-goldengate-optimizer-run')).toBeVisible();
    expectOptimizeSlotAbovePrimerCards();
  });

  it('surfaces ranked Golden Gate overhang combinations and applies the selected rank', () => {
    const design = draftedGoldenGateOptimizerDesign();
    const plan = planGoldenGateAutoOptimization(buildAssemblyOptimizationInput(design));
    expect(plan.status).toBe('planned');
    if (plan.status !== 'planned') throw new Error('Expected Golden Gate optimizer plan');
    expect(plan.topCombinations.length).toBeGreaterThan(1);
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
      pendingDispatchId: null,
    });

    const { container } = render(<JunctionWorkbench design={design} />);

    expect(screen.queryByTestId('assembly-workbench-goldengate-optimizer')).toBeNull();
    fireEvent.click(screen.getByTestId('assembly-workbench-goldengate-optimizer-run'));
    const optimizer = screen.getByTestId('assembly-workbench-goldengate-optimizer');
    const productRowSequences = () =>
      Array.from(container.querySelectorAll('[data-product-row-sequence]')).map(
        (element) => element.getAttribute('data-product-row-sequence') ?? ''
      );
    const currentOverhangs = (design.goldenGateJunctions ?? []).map(
      (junction) => junction.overhang
    );
    expect(optimizer).toBeVisible();
    expect(screen.queryByTestId('assembly-workbench-goldengate-optimizer-prev')).toBeNull();
    expect(screen.queryByTestId('assembly-workbench-goldengate-optimizer-next')).toBeNull();
    const orderedWorkbenchSurfaces = Array.from(
      container.querySelectorAll(
        '[data-testid="junction-workbench-card"], [data-testid="assembly-workbench-goldengate-optimizer"]'
      )
    );
    expect(orderedWorkbenchSurfaces.at(0)).toBe(optimizer);
    expect(screen.getByTestId('assembly-workbench-goldengate-optimizer-rank')).toHaveTextContent(
      'Manual'
    );
    expect(optimizer).toHaveAttribute('data-state', 'current');
    const searchStatus = screen.getByTestId(
      'assembly-workbench-goldengate-optimizer-search-status'
    );
    expect(searchStatus).toHaveAttribute('data-exhaustive', String(plan.exhaustive));
    expect(searchStatus).toHaveTextContent(
      plan.exhaustive ? 'Search complete' : 'Stopped at budget'
    );
    expect(screen.getByTestId('assembly-workbench-goldengate-optimizer-apply')).toHaveTextContent(
      'Apply'
    );
    expect(screen.getByTestId('assembly-workbench-goldengate-optimizer-apply')).toBeDisabled();
    expect(screen.getByTestId('assembly-workbench-goldengate-optimizer-header')).toHaveTextContent(
      'J1'
    );
    expect(screen.getByTestId('assembly-workbench-goldengate-optimizer-header')).toHaveTextContent(
      'J2'
    );
    expect(
      screen.getByTestId('assembly-workbench-goldengate-optimizer-header')
    ).not.toHaveTextContent('Edits');
    expect(
      screen.getByTestId('assembly-workbench-goldengate-optimizer-cell-0-junction-0')
    ).toHaveTextContent(plan.topCombinations[0].choices[0].overhang);
    expect(plan.topCombinations[0].changedCount).toBe(0);
    expect(plan.topCombinations[0].choices.map((choice) => choice.overhang)).toEqual(
      currentOverhangs
    );
    expect(
      screen.getByTestId('assembly-workbench-goldengate-optimizer-cell-1-junction-0')
    ).toHaveTextContent(plan.topCombinations[1].choices[0].overhang);
    const optimizerList = screen.getByTestId('assembly-workbench-goldengate-optimizer-list');
    expect(optimizerList).toHaveAttribute('data-row-count', String(plan.topCombinations.length));
    expect(optimizerList.className).not.toMatch(/max-h-24/);
    expect(screen.getAllByRole('option')).toHaveLength(plan.topCombinations.length);
    for (const combination of plan.topCombinations) {
      expect(
        screen.getByTestId(`assembly-workbench-goldengate-optimizer-row-${combination.rank}`)
      ).toBeVisible();
    }
    expect(screen.getByTestId('assembly-workbench-goldengate-optimizer-row-0')).toBeVisible();
    expect(screen.getByTestId('assembly-workbench-goldengate-optimizer-row-0')).toHaveTextContent(
      'Manual'
    );
    expect(
      screen.getByTestId('assembly-workbench-goldengate-optimizer-row-0')
    ).not.toHaveTextContent('Man...');
    expect(screen.getByTestId('assembly-workbench-goldengate-optimizer-row-1')).toBeVisible();
    expect(
      screen.getByTestId('assembly-workbench-goldengate-optimizer-cell-0-junction-0').parentElement
    ).not.toHaveTextContent(' · ');
    expect(screen.queryByTestId('assembly-workbench-goldengate-optimizer-score')).toBeNull();
    expect(screen.getByTestId('assembly-workbench-goldengate-optimizer-row-0')).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByTestId('assembly-workbench-goldengate-optimizer-row-0')).not.toHaveClass(
      'ring-1'
    );
    expect(screen.getByTestId('assembly-workbench-goldengate-optimizer-row-0')).not.toHaveClass(
      'bg-accent/14'
    );
    expect(screen.getByTestId('assembly-workbench-goldengate-optimizer-row-0')).not.toHaveClass(
      'bg-accent/10'
    );
    expect(screen.getByTestId('assembly-workbench-goldengate-optimizer-row-0')).toHaveClass(
      'bg-bg'
    );
    expect(screen.getByTestId('assembly-workbench-goldengate-optimizer-row-0')).toHaveAttribute(
      'data-current-design',
      'true'
    );
    expect(screen.getByTestId('assembly-workbench-goldengate-optimizer-row-0')).toHaveAttribute(
      'data-previewing',
      'false'
    );
    expect(
      screen.queryByTestId('assembly-workbench-goldengate-optimizer-current-badge')
    ).toBeNull();
    expect(
      screen.queryByTestId('assembly-workbench-goldengate-optimizer-preview-badge')
    ).toBeNull();
    expect(screen.getByTestId('assembly-workbench-goldengate-optimizer-row-0')).toHaveAttribute(
      'tabindex',
      '-1'
    );
    expect(screen.getByTestId('assembly-workbench-goldengate-optimizer-row-0')).toHaveClass(
      'outline-none'
    );
    expect(optimizer).not.toHaveClass('focus-visible:ring-1');
    expect(optimizer).not.toHaveClass('focus-visible:border-accent');
    expect(productRowSequences()).toEqual(currentOverhangs);
    const firstOverhangs = optimizer.getAttribute('data-overhangs') ?? '';

    fireEvent.keyDown(optimizer, { key: 'Enter' });
    expect(useDesignStore.getState().designs[design.id].version).toBe(design.version);
    expect(optimizer).toHaveAttribute('data-state', 'current');
    expect(screen.getByTestId('assembly-workbench-goldengate-optimizer-apply')).toBeDisabled();

    fireEvent.mouseDown(screen.getByTestId('assembly-workbench-goldengate-optimizer-row-0'));
    fireEvent.click(screen.getByTestId('assembly-workbench-goldengate-optimizer-row-0'));
    expect(optimizer).toHaveFocus();
    expect(screen.getByTestId('assembly-workbench-goldengate-optimizer-row-0')).not.toHaveFocus();

    fireEvent.keyDown(optimizer, { key: 'ArrowDown' });

    expect(screen.getByTestId('junction-workbench')).toHaveAttribute(
      'data-workbench-preview-active',
      'true'
    );
    expect(screen.getByTestId('junction-workbench')).toHaveAttribute(
      'data-workbench-preview-command',
      'autoOptimize'
    );
    expect(useDesignStore.getState().designs[design.id].version).toBe(design.version);
    expect(productRowSequences()).toEqual(currentOverhangs);
    for (const choice of plan.topCombinations[1].choices) {
      expect(
        screen.getByTestId(`assembly-workbench-goldengate-control-${choice.junctionIndex}`)
      ).toHaveTextContent(choice.overhang);
      expect(
        screen.getByTestId(`assembly-workbench-goldengate-offset-${choice.junctionIndex}`)
      ).toHaveValue(choice.offset);
    }
    const previewTrace = JSON.parse(
      screen.getByTestId('junction-workbench').getAttribute('data-workbench-last-command-trace') ??
        '{}'
    ) as {
      commandType?: string;
      goldenGateJunctionDeltas?: Array<{ junctionIndex: number; overhangAfter: string }>;
    };
    const selectedPreviewOverhangs = new Map(
      plan.topCombinations[1].choices.map((choice) => [choice.junctionIndex, choice.overhang])
    );
    const expectedPreviewDeltas = (design.goldenGateJunctions ?? [])
      .map((junction) => ({
        junctionIndex: junction.junctionIndex,
        overhangBefore: junction.overhang,
        overhangAfter: selectedPreviewOverhangs.get(junction.junctionIndex) ?? junction.overhang,
      }))
      .filter((delta) => delta.overhangBefore !== delta.overhangAfter)
      .map(({ junctionIndex, overhangAfter }) => ({ junctionIndex, overhangAfter }));
    expect(previewTrace.commandType).toBe('autoOptimize');
    expect(
      (previewTrace.goldenGateJunctionDeltas ?? []).map(({ junctionIndex, overhangAfter }) => ({
        junctionIndex,
        overhangAfter,
      }))
    ).toEqual(expectedPreviewDeltas);
    expect(screen.getByTestId('assembly-workbench-goldengate-optimizer-rank')).toHaveTextContent(
      '1'
    );
    expect(optimizer).toHaveAttribute('data-state', 'preview');
    expect(screen.getByTestId('assembly-workbench-goldengate-optimizer-apply')).toHaveTextContent(
      'Apply'
    );
    expect(screen.getByTestId('assembly-workbench-goldengate-optimizer-apply')).toBeEnabled();
    expect(screen.getByTestId('assembly-workbench-goldengate-optimizer-row-1')).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByTestId('assembly-workbench-goldengate-optimizer-row-1')).toHaveClass(
      'outline-none'
    );
    expect(screen.getByTestId('assembly-workbench-goldengate-optimizer-row-1')).toHaveAttribute(
      'data-previewing',
      'true'
    );
    expect(
      screen.queryByTestId('assembly-workbench-goldengate-optimizer-preview-badge')
    ).toBeNull();
    expect(screen.getByTestId('assembly-workbench-goldengate-optimizer-row-0')).not.toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByTestId('assembly-workbench-goldengate-optimizer-row-0')).toHaveAttribute(
      'data-current-design',
      'true'
    );
    expect(
      screen.queryByTestId('assembly-workbench-goldengate-optimizer-current-badge')
    ).toBeNull();
    expect(optimizer).not.toHaveAttribute('data-overhangs', firstOverhangs);

    fireEvent.keyDown(optimizer, { key: 'Enter' });

    const optimized = useDesignStore.getState().designs[design.id];
    expect(optimized.version).toBe(design.version + 1);
    expect((optimized.goldenGateJunctions ?? []).map((junction) => junction.overhang)).toEqual(
      plan.topCombinations[1].choices.map((choice) => choice.overhang)
    );
    expect(optimizer).toHaveAttribute('data-state', 'current');
    expect(screen.getByTestId('assembly-workbench-goldengate-optimizer-rank')).toHaveTextContent(
      'Manual'
    );
    expect(screen.getByTestId('assembly-workbench-goldengate-optimizer-apply')).toHaveTextContent(
      'Apply'
    );
    expect(screen.getByTestId('assembly-workbench-goldengate-optimizer-apply')).toBeDisabled();
  });

  it('does not present a budget-limited Golden Gate search as proven optimal ', () => {
    setGoldenGateExactSearchNodeLimitForTesting(8);
    const design = draftedGoldenGateOptimizerDesign();
    const plan = planGoldenGateAutoOptimization(buildAssemblyOptimizationInput(design), {
      maxExactSearchNodes: 8,
    });
    expect(plan.status).toBe('planned');
    if (plan.status !== 'planned') throw new Error('Expected Golden Gate optimizer plan');
    expect(plan.exhaustive).toBe(false);

    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
      lastCopied: null,
      pendingDispatchId: null,
    });

    render(<JunctionWorkbench design={design} />);
    fireEvent.click(screen.getByTestId('assembly-workbench-goldengate-optimizer-run'));

    const searchStatus = screen.getByTestId(
      'assembly-workbench-goldengate-optimizer-search-status'
    );
    expect(searchStatus).toHaveAttribute('data-exhaustive', 'false');
    expect(searchStatus).toHaveTextContent('Stopped at budget');
    expect(searchStatus).not.toHaveTextContent('Search complete');
    expect(searchStatus).not.toHaveTextContent('Proven best');
  });

  it('collapses Golden Gate optimizer when product DNA changes so search does not rerun on each keystroke', () => {
    const design = draftedGoldenGateOptimizerDesign();
    const beforeFingerprint = buildAssemblyOptimizationInput(design).optimizationFingerprint;
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
      lastCopied: null,
      pendingDispatchId: null,
    });

    function Harness() {
      const liveDesign = useDesignStore((state) => state.designs[design.id] ?? design);
      return <JunctionWorkbench design={liveDesign} />;
    }

    render(<Harness />);
    fireEvent.click(screen.getByTestId('assembly-workbench-goldengate-optimizer-run'));
    const optimizer = screen.getByTestId('assembly-workbench-goldengate-optimizer');
    expect(optimizer).toHaveAttribute('data-optimization-fingerprint', beforeFingerprint);
    expect(screen.getByTestId('junction-workbench')).toHaveAttribute(
      'data-workbench-product-identity',
      beforeFingerprint
    );

    fireEvent.keyDown(optimizer, { key: 'ArrowDown' });
    expect(screen.getByTestId('junction-workbench')).toHaveAttribute(
      'data-workbench-preview-active',
      'true'
    );

    act(() => {
      useDesignStore.getState().setJunctionSpacer(design.id, 0, 'GATTACA');
    });

    const afterDesign = useDesignStore.getState().designs[design.id];
    const afterFingerprint = buildAssemblyOptimizationInput(afterDesign).optimizationFingerprint;
    expect(afterDesign.spacers[0]?.sequence).toBe('GATTACA');
    expect(afterFingerprint).not.toBe(beforeFingerprint);
    expect(screen.queryByTestId('assembly-workbench-goldengate-optimizer')).toBeNull();
    expect(screen.getByTestId('assembly-workbench-goldengate-optimizer-run')).toBeVisible();
    expect(screen.getByTestId('junction-workbench')).toHaveAttribute(
      'data-workbench-product-identity',
      afterFingerprint
    );
    expect(screen.getByTestId('junction-workbench')).toHaveAttribute(
      'data-workbench-preview-active',
      'false'
    );
  });
});

function expectOptimizeSlotAbovePrimerCards(): void {
  const cards = screen.getAllByTestId('junction-workbench-card');
  const slot = screen.getByTestId('assembly-workbench-optimize');
  const firstCard = cards[0];
  expect(slot.compareDocumentPosition(firstCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING
  );
}

function draftedDesignWithHomologyLengthWarning(): SequenceDesign {
  const design = draftedDesignWithoutFindings();
  return {
    ...design,
    homologyRegions: design.homologyRegions.map((homology, index) =>
      index === 0
        ? ({
            ...homology,
            encoding: { onLeft: 20, onRight: 21 },
          } satisfies HomologyRegion)
        : homology
    ),
    version: 1,
  };
}

function draftedDesignWithTemperatureReadouts(): SequenceDesign {
  const design = baseDraftedDesign();
  return {
    ...design,
    homologyRegions: design.homologyRegions.map(
      (homology, index) =>
        ({
          ...homology,
          metadata: {
            ...homology.metadata,
            tmEstimate: index === 0 ? 47.6 : 49.0,
            ...(index === 0 ? { gcContent: 45.2 } : {}),
          },
        }) satisfies HomologyRegion
    ),
    designPrimers: design.designPrimers.map((pair) => ({
      ...pair,
      forward:
        pair.fragmentIndex === 1 ? { ...pair.forward, tm: 61.2 } : { ...pair.forward, tm: 59.9 },
      reverse:
        pair.fragmentIndex === 0
          ? { ...normalizePrimerPbsLength(pair.reverse, 20), tm: 58.4 }
          : { ...pair.reverse, tm: 60.1 },
    })),
  };
}

function draftedDesignWithPrimerWarning(): SequenceDesign {
  const design = draftedDesignWithoutFindings();
  return {
    ...design,
    designPrimers: design.designPrimers.map((pair, index) =>
      index === 0
        ? {
            ...pair,
            reverse: normalizePrimerPbsLength(pair.reverse, 40),
          }
        : pair
    ),
  };
}

function draftedRdAdjacentHomologyDesign(rdSide: 'left' | 'right'): SequenceDesign {
  const design = baseDesign('gibson');
  design.topology = 'linear';
  design.spacers = [{ id: 'spacer-j0', junctionIndex: 0, sequence: 'GGCC' }];
  const pcr = region('pcr', 'ATGC'.repeat(28) + 'GATTACA'.repeat(4));
  const rd: DesignRegion = {
    ...region('rd', 'TTAACCGGTTAACCGG' + 'CGTA'.repeat(24)),
    sourceType: 'rd',
    rdOverhangs: { upstream: 'AATG', downstream: 'GCTA' },
    rdSourceEnzyme: 'BsaI',
  };
  const base = {
    ...design,
    regions: rdSide === 'left' ? [rd, pcr] : [pcr, rd],
  };
  const draft = computeDraftAssembly(base);
  return {
    ...base,
    homologyRegions: draft.homologyRegions,
    designPrimers: draft.designPrimers,
    assemblyState: 'ready',
    status: 'computed',
    version: 1,
  };
}

function draftedDesignWithoutFindings(): SequenceDesign {
  const design = baseDraftedDesign();
  return {
    ...design,
    homologyRegions: design.homologyRegions.map((homology) => ({
      ...homology,
      encoding: { onLeft: 15, onRight: 15 },
      metadata: {
        ...homology.metadata,
        tmEstimate: 50,
        gcContent: 50,
      },
    })),
    designPrimers: design.designPrimers.map((pair) => ({
      ...pair,
      forward: normalizePrimerPbsLength(pair.forward, 20),
      reverse: normalizePrimerPbsLength(pair.reverse, 20),
    })),
  };
}

function draftedGoldenGateOptimizerDesign(): SequenceDesign {
  const design = baseDesign('goldengate');
  design.topology = 'linear';
  design.regions = [
    region('r1', 'C'.repeat(32) + 'GAT'),
    region('r2', 'ATG' + 'C'.repeat(30) + 'CAT'),
    region('r3', 'ATC' + 'G'.repeat(30) + 'GGA'),
    rdRegion('rd', 'A'.repeat(64), { upstream: 'AATG', downstream: 'GCAA' }),
  ];
  design.goldenGateConfig = { enzyme: 'BsaI', offsetLimitBp: 6 };
  const draft = computeDraftAssembly(design);
  return {
    ...design,
    homologyRegions: draft.homologyRegions,
    designPrimers: draft.designPrimers,
    goldenGateJunctions: draft.goldenGateJunctions,
    assemblyState: 'ready',
    status: 'computed',
    version: 1,
  };
}

function draftedCircularGoldenGateDesign(): SequenceDesign {
  const design = baseDesign('goldengate');
  design.goldenGateConfig = { enzyme: 'BsaI', offsetLimitBp: 6 };
  const draft = computeDraftAssembly(design);
  return {
    ...design,
    homologyRegions: draft.homologyRegions,
    designPrimers: draft.designPrimers,
    goldenGateJunctions: draft.goldenGateJunctions,
    assemblyState: 'ready',
    status: 'computed',
    version: 1,
  };
}

function normalizePrimerPbsLength(primer: DesignPrimer, length: number): DesignPrimer {
  if (primer.direction === 'forward') {
    return {
      ...primer,
      pbs: { ...primer.pbs, end: primer.pbs.start + length },
    };
  }
  return {
    ...primer,
    pbs: { ...primer.pbs, start: primer.pbs.end - length },
  };
}

function baseDraftedDesign(): SequenceDesign {
  const design = baseDesign('gibson');
  const draft = computeDraftAssembly(design);
  return {
    ...design,
    homologyRegions: draft.homologyRegions,
    designPrimers: draft.designPrimers,
    assemblyState: 'ready',
    status: 'computed',
    version: 1,
  };
}

function baseDesign(method: SequenceDesign['assemblyMethod']): SequenceDesign {
  const now = new Date('2026-05-12T00:00:00.000Z');
  return {
    id: `design-${method}`,
    name: `${method} workbench`,
    topology: 'circular',
    regions: [region('r1', 'ACGT'.repeat(60)), region('r2', 'TGCA'.repeat(60))],
    spacers: [],
    version: 0,
    assemblyState: 'drafting',
    validationErrors: [],
    proposedPlans: [],
    status: 'draft',
    assemblyMethod: method,
    backboneSequenceId: null,
    defaultHomologyLength: 30,
    homologyRegions: [],
    goldenGateConfig: undefined,
    goldenGateJunctions: undefined,
    designPrimers: [],
    selectedJunctionIndex: 0,
    scrollToPosition: null,
    highlightRange: null,
    createdAt: now,
    updatedAt: now,
  };
}

function region(id: string, sequence: string): DesignRegion {
  return {
    id,
    sourceSequenceId: id,
    sourceSequenceName: id,
    sourceStart: 0,
    sourceEnd: sequence.length,
    sequence,
    annotations: [],
    sourceType: 'pcr',
  };
}

function rdRegion(
  id: string,
  sequence: string,
  overhangs: { upstream: string; downstream: string }
): DesignRegion {
  return {
    ...region(id, sequence),
    sourceType: 'rd',
    ggType: 'insert',
    rdOverhangs: overhangs,
    rdSourceEnzyme: 'BsaI',
    rdSourceEnzymeName: 'BsaI',
  };
}
