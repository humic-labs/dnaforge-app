// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SequenceToolbarSidebar } from '../SequenceToolbarSidebar';
import { useSequenceSelectionState } from '../useSequenceSelectionState';
import { useSequenceClipboardActions } from '../useSequenceClipboardActions';
import { DEFAULT_VIEWER_CONFIG } from '../../types';
import type { SelectionRange } from '../../selection-state';
import { calculateTmNN } from '../../../design/public/algorithms/tm-calculator';
import { localTmRangeForModel } from '../../../design/public/algorithms/local-tm';
import { formatSelectionTm } from '../format-selection-tm';
import { useSettingsStore } from '../../../junction-workbench/public/settings';
import {
  DEFAULT_TM_MODEL,
  DEFAULT_TM_CONDITIONS,
  DEFAULT_PRIMER_CONC_NM,
  OWCZARZY_TM_MODEL,
} from '../../../design/public/algorithms/tm-model';

vi.mock('../../../../lib/workflow-telemetry', () => ({ observeWorkflowAction: vi.fn() }));

const sequence = 'ATGCGATCGATCGATCGATCGCGGCCGCGGATCCATATATATATGCGATCGATC';
const projector = {
  position: (position: number | null) => position,
  selection: (range: SelectionRange) => range,
  selectionAsRange: (range: SelectionRange) => range,
};

function mountViewer(
  options: {
    sequenceText?: string;
    scaffoldRanges?: readonly { start: number; end: number }[];
    minimap?: boolean;
  } = {}
) {
  let selection!: ReturnType<typeof useSequenceSelectionState>;
  let actions!: ReturnType<typeof useSequenceClipboardActions>;
  const renderViewer = vi.fn();
  const onSelectionChange = vi.fn();
  const setSelection = vi.fn();
  const sequenceText = options.sequenceText ?? sequence;
  const minimapRef = { current: options.minimap ? { setSelection } : null };
  function Viewer({ source = 'document-a' }: { source?: string }) {
    renderViewer();
    selection = useSequenceSelectionState({
      selectionSourceIdentity: source,
      sequenceViewToSource: projector,
      minimapRef,
      onSelectionChange,
    });
    actions = useSequenceClipboardActions({
      highlightedRange: selection.highlightedRange,
      sequenceText,
      sequenceLength: sequenceText.length,
      scaffoldRanges: options.scaffoldRanges,
      sequenceViewToSource: projector,
      sequenceViewCopyOrientation: () => 'forward',
      effectiveCDS: null,
      setHighlightedRange: selection.setHighlightedRange,
    });
    return (
      <SequenceToolbarSidebar
        config={DEFAULT_VIEWER_CONFIG}
        onConfigChange={vi.fn()}
        sequenceLength={sequenceText.length}
        selectionLength={actions.selectionLength}
        selectionTmReadout={actions.selectionTmReadout}
        selectionPreview={{
          store: selection.selectionPreviewStore,
          highlightedRange: selection.highlightedRange,
          sequenceText,
          scaffoldRanges: options.scaffoldRanges,
        }}
      />
    );
  }
  const view = render(<Viewer />);
  return {
    get selection() {
      return selection;
    },
    get actions() {
      return actions;
    },
    renderViewer,
    onSelectionChange,
    setSelection,
    replaceSource: () => view.rerender(<Viewer source="document-b" />),
  };
}

function expectReadout(bases: string) {
  expect(screen.getByTestId('selection-length')).toHaveTextContent(`${bases.length} bp`);
  expect(screen.getByTestId('selection-tm')).toHaveTextContent(
    `${Math.round(calculateTmNN(bases, { primerConc: 500 }))}°C`
  );
}

describe('live selection Tm ', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      tmModel: DEFAULT_TM_MODEL,
      tmConditions: DEFAULT_TM_CONDITIONS,
      primerConcNm: DEFAULT_PRIMER_CONC_NM,
    });
  });

  it('updates while extending and shrinking before release without rerendering or committing the viewer', () => {
    const viewer = mountViewer({ minimap: true });
    act(() => viewer.selection.handleSequenceHighlightedRangeChange({ start: 0, end: 19 }));
    expectReadout(sequence.slice(0, 20));
    const renders = viewer.renderViewer.mock.calls.length;
    viewer.onSelectionChange.mockClear();

    for (const end of [25, 11, 21]) {
      act(() => viewer.selection.handleSequenceHighlightedRangePreview({ start: 0, end }));
      expectReadout(sequence.slice(0, end + 1));
      expect(viewer.selection.highlightedRange).toMatchObject({ start: 0, end: 19 });
      expect(viewer.actions.getSelectedSequenceText()).toBe(sequence.slice(0, 20));
    }
    expect(viewer.renderViewer).toHaveBeenCalledTimes(renders);
    expect(viewer.onSelectionChange).not.toHaveBeenCalled();
    expect(viewer.setSelection).toHaveBeenLastCalledWith(0, 21, undefined);

    act(() => viewer.selection.handleSequenceHighlightedRangeChange({ start: 0, end: 21 }));
    expectReadout(sequence.slice(0, 22));
    act(() => viewer.selection.setHighlightedRange({ start: 8, end: 25 }));
    expectReadout(sequence.slice(8, 26));
  });

  it('shows a fresh preview with the map hidden and handles an origin-wrapping range', () => {
    const viewer = mountViewer();
    const start = sequence.length - 8;
    act(() =>
      viewer.selection.handleSequenceHighlightedRangePreview({ start, end: 7, wraps: true })
    );
    expectReadout(sequence.slice(start) + sequence.slice(0, 8));
    expect(viewer.selection.selection.kind).toBe('none');
    act(() => viewer.selection.clearSequenceSelection());
    expect(screen.queryByTestId('selection-length')).not.toBeInTheDocument();
    expect(screen.queryByTestId('selection-tm')).not.toBeInTheDocument();
  });

  it('uses the active salt model and concentration during preview', () => {
    const viewer = mountViewer();
    act(() => viewer.selection.handleSequenceHighlightedRangePreview({ start: 4, end: 24 }));
    expectReadout(sequence.slice(4, 25));
    act(() =>
      useSettingsStore.setState({
        tmModel: OWCZARZY_TM_MODEL,
        tmConditions: { monovalentMm: 75, divalentMm: 2, dntpMm: 0.8 },
        primerConcNm: 125,
      })
    );
    const expected = calculateTmNN(sequence.slice(4, 25), {
      primerConc: 125,
      naConc: 75,
      mgConc: 2,
      dntpConc: 0.8,
      saltMethod: 'owczarzy',
    });
    expect(screen.getByTestId('selection-tm')).toHaveTextContent(`${Math.round(expected)}°C`);
  });

  it('preserves degenerate ranges and excludes assembly scaffold columns', () => {
    const sequenceText = 'ATGCGATC......NNKATCGATC';
    const viewer = mountViewer({ sequenceText, scaffoldRanges: [{ start: 8, end: 14 }] });
    act(() =>
      viewer.selection.handleSequenceHighlightedRangePreview({
        start: 0,
        end: sequenceText.length - 1,
      })
    );
    const bases = sequenceText.replace(/\./g, '');
    const readout = localTmRangeForModel(bases, DEFAULT_TM_MODEL, DEFAULT_TM_CONDITIONS, 500);
    expect(readout.kind).toBe('range');
    expect(screen.getByTestId('selection-length')).toHaveTextContent(`${bases.length} bp`);
    expect(screen.getByTestId('selection-tm')).toHaveTextContent(
      formatSelectionTm(readout, null).text!
    );
  });

  it('clears stale Tm outside the supported length and on source replacement', () => {
    const viewer = mountViewer({ sequenceText: sequence.repeat(3) });
    act(() => viewer.selection.handleSequenceHighlightedRangeChange({ start: 0, end: 19 }));
    for (const end of [3, 105]) {
      act(() => viewer.selection.handleSequenceHighlightedRangePreview({ start: 0, end }));
      expect(screen.getByTestId('selection-length')).toHaveTextContent(`${end + 1} bp`);
      expect(screen.queryByTestId('selection-tm')).not.toBeInTheDocument();
    }
    act(() => viewer.selection.handleSequenceHighlightedRangePreview({ start: 0, end: 17 }));
    expectReadout(sequence.slice(0, 18));
    viewer.replaceSource();
    expect(screen.queryByTestId('selection-tm')).not.toBeInTheDocument();
    expect(screen.queryByTestId('selection-length')).not.toBeInTheDocument();
  });
});
