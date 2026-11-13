import { act, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { COMPILED_BROAD_SURFACE_MAX_FINITE_LANE_LIMIT_V2 } from '@waypoint/genome-renderer/pure';

import {
  COVERAGE_CUTOFF_SLIDER_MAX,
  CoverageCutoffControl,
  coverageDepthScaleFromDiagnostics,
  coverageDepthToSliderPosition,
  coverageSliderPositionToDepth,
} from './CoverageCutoffControl';
import type { IndexedGenomeTileNativeMapHandle } from './IndexedGenomeTileNativeMap';
import { ReferenceTrackControls } from './ReferenceTrackControls';
import { pickSpliceDemoFeature } from './indexed-genome-legacy-adapter';

function feature(
  type: string,
  start: number,
  end: number,
  overrides: Record<string, unknown> = {}
) {
  return {
    chrom: 'chr11',
    source: 'fixture',
    type,
    start,
    end,
    score: null,
    strand: '+',
    phase: null,
    attributes: { ID: [`${type}-${start}`] },
    raw: '',
    ...overrides,
  };
}

describe('IndexedGenomeViewer gutter controls', () => {
  it('keeps the isoform switch beside the Reference lane picker', () => {
    const onToggleTranscriptDisplayMode = vi.fn();
    const onChangeLaneLimit = vi.fn();

    render(
      <ReferenceTrackControls
        laneLimit={12}
        onChangeLaneLimit={onChangeLaneLimit}
        transcriptDisplayMode="canonical"
        onToggleTranscriptDisplayMode={onToggleTranscriptDisplayMode}
        expandedGeneCount={0}
      />
    );

    const pressureControls = screen.getByTestId('reference-track-controls');
    expect(pressureControls).toContainElement(
      screen.getByRole('button', { name: /primary only/i })
    );
    const lanePicker = screen.getByLabelText('Max lanes');
    expect(pressureControls).toContainElement(lanePicker);
    expect(lanePicker).toHaveValue('12');
    expect(screen.queryByLabelText('Exact max lanes')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Apply exact lane limit' })
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/new glyph \(click to swap\)/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/jump to splice demo/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /primary only/i }));
    expect(onToggleTranscriptDisplayMode).toHaveBeenCalledTimes(1);

    fireEvent.change(lanePicker, { target: { value: '1' } });
    fireEvent.keyDown(lanePicker, { key: 'Enter' });
    expect(onChangeLaneLimit).toHaveBeenLastCalledWith(1);
    fireEvent.change(lanePicker, { target: { value: '2' } });
    fireEvent.keyDown(lanePicker, { key: 'Enter' });
    expect(onChangeLaneLimit).toHaveBeenLastCalledWith(2);
    fireEvent.change(lanePicker, { target: { value: '17' } });
    fireEvent.keyDown(lanePicker, { key: 'Enter' });
    expect(onChangeLaneLimit).toHaveBeenLastCalledWith(17);
    fireEvent.change(lanePicker, { target: { value: '65' } });
    expect(lanePicker).toHaveAttribute('aria-invalid', 'true');
    fireEvent.keyDown(lanePicker, { key: 'Enter' });
    expect(onChangeLaneLimit).toHaveBeenCalledTimes(3);
    fireEvent.change(lanePicker, { target: { value: 'All' } });
    fireEvent.keyDown(lanePicker, { key: 'Enter' });
    expect(onChangeLaneLimit).toHaveBeenLastCalledWith(null);
    expect(lanePicker).toHaveAttribute('role', 'spinbutton');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('uses one editable rounded spinbox with integrated exact-value steppers', () => {
    const onChangeLaneLimit = vi.fn();
    render(
      <ReferenceTrackControls
        laneLimit={2}
        onChangeLaneLimit={onChangeLaneLimit}
        transcriptDisplayMode="canonical"
        onToggleTranscriptDisplayMode={vi.fn()}
        expandedGeneCount={0}
      />
    );

    const spinboxShell = screen.getByTestId('lane-limit-spinbox');
    const laneInput = screen.getByRole('spinbutton', { name: 'Max lanes' });
    expect(spinboxShell).toContainElement(laneInput);
    expect(spinboxShell).toContainElement(screen.getByLabelText('Increase max lanes'));
    expect(spinboxShell).toContainElement(screen.getByLabelText('Decrease max lanes'));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Increase max lanes'));
    expect(onChangeLaneLimit).toHaveBeenLastCalledWith(3);
    expect(laneInput).toHaveValue('3');
    fireEvent.click(screen.getByLabelText('Decrease max lanes'));
    expect(onChangeLaneLimit).toHaveBeenLastCalledWith(2);
    expect(laneInput).toHaveValue('2');
  });

  it('commits a typed exact value and restores the committed value after failure', () => {
    const onChangeLaneLimit = vi.fn();
    const props = {
      laneLimit: 2 as const,
      onChangeLaneLimit,
      transcriptDisplayMode: 'canonical' as const,
      onToggleTranscriptDisplayMode: vi.fn(),
      expandedGeneCount: 0,
    };
    const { rerender } = render(<ReferenceTrackControls {...props} />);
    const lanePicker = screen.getByLabelText('Max lanes');

    fireEvent.change(lanePicker, { target: { value: '4' } });
    fireEvent.keyDown(lanePicker, { key: 'Enter' });
    expect(onChangeLaneLimit).toHaveBeenCalledWith(4);
    expect(lanePicker).toHaveValue('4');

    rerender(<ReferenceTrackControls {...props} annotationPreparationState="preparing" />);
    expect(lanePicker).toHaveValue('4');
    expect(screen.getByTestId('annotation-policy-preparation-state')).toHaveTextContent(
      'Applying annotation settings…'
    );
    rerender(<ReferenceTrackControls {...props} annotationPreparationState="error" />);
    expect(lanePicker).toHaveValue('2');
    expect(screen.getByText('Couldn’t apply annotation settings')).toBeVisible();
    expect(screen.getByTestId('annotation-policy-preparation-state')).toHaveAttribute(
      'title',
      'The previous annotation settings are still displayed.'
    );
    expect(lanePicker).not.toBeDisabled();
  });

  it('advertises only the finite lane capability supplied by a compiled surface', () => {
    render(
      <ReferenceTrackControls
        laneLimit={COMPILED_BROAD_SURFACE_MAX_FINITE_LANE_LIMIT_V2}
        onChangeLaneLimit={vi.fn()}
        maxSupportedFiniteLaneLimit={COMPILED_BROAD_SURFACE_MAX_FINITE_LANE_LIMIT_V2}
        transcriptDisplayMode="expanded"
        onToggleTranscriptDisplayMode={vi.fn()}
        expandedGeneCount={0}
      />
    );

    expect(screen.getByRole('button', { name: '✓ All isoforms' })).toBeEnabled();
    expect(screen.getByLabelText('Max lanes')).toHaveValue(
      String(COMPILED_BROAD_SURFACE_MAX_FINITE_LANE_LIMIT_V2)
    );
    const lanePicker = screen.getByLabelText('Max lanes');
    expect(lanePicker).toHaveAttribute('aria-valuemax', '64');
    expect(lanePicker).toHaveAttribute('aria-valuetext', '64 lanes');
    expect(screen.getByLabelText('Increase max lanes')).toBeDisabled();
    expect(screen.getByLabelText('Decrease max lanes')).toBeEnabled();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('marks empty drafts invalid and lets a boundary step restore the committed value', () => {
    const onChangeLaneLimit = vi.fn();
    render(
      <ReferenceTrackControls
        laneLimit={COMPILED_BROAD_SURFACE_MAX_FINITE_LANE_LIMIT_V2}
        onChangeLaneLimit={onChangeLaneLimit}
        maxSupportedFiniteLaneLimit={COMPILED_BROAD_SURFACE_MAX_FINITE_LANE_LIMIT_V2}
        transcriptDisplayMode="canonical"
        onToggleTranscriptDisplayMode={vi.fn()}
        expandedGeneCount={0}
      />
    );

    const laneInput = screen.getByLabelText('Max lanes');
    fireEvent.change(laneInput, { target: { value: '' } });
    expect(laneInput).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Increase max lanes')).toBeEnabled();
    fireEvent.click(screen.getByLabelText('Increase max lanes'));
    expect(laneInput).toHaveValue('64');
    expect(laneInput).toHaveAttribute('aria-invalid', 'false');
    expect(onChangeLaneLimit).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Increase max lanes')).toBeDisabled();
  });

  it('accepts any supported exact finite lane count and rejects values beyond capability', () => {
    const onChangeLaneLimit = vi.fn();
    render(
      <ReferenceTrackControls
        laneLimit={2}
        onChangeLaneLimit={onChangeLaneLimit}
        maxSupportedFiniteLaneLimit={COMPILED_BROAD_SURFACE_MAX_FINITE_LANE_LIMIT_V2}
        transcriptDisplayMode="canonical"
        onToggleTranscriptDisplayMode={vi.fn()}
        expandedGeneCount={0}
      />
    );

    const lanePicker = screen.getByLabelText('Max lanes');
    fireEvent.change(lanePicker, { target: { value: '37' } });
    fireEvent.keyDown(lanePicker, { key: 'Enter' });
    expect(onChangeLaneLimit).toHaveBeenLastCalledWith(37);

    fireEvent.change(lanePicker, { target: { value: '65' } });
    expect(lanePicker).toHaveAttribute('aria-invalid', 'true');
    fireEvent.keyDown(lanePicker, { key: 'Enter' });
    expect(onChangeLaneLimit).toHaveBeenCalledTimes(1);
  });

  it('cancels an edited exact lane count on Escape without committing it on blur', () => {
    const onChangeLaneLimit = vi.fn();
    render(
      <ReferenceTrackControls
        laneLimit={2}
        onChangeLaneLimit={onChangeLaneLimit}
        transcriptDisplayMode="canonical"
        onToggleTranscriptDisplayMode={vi.fn()}
        expandedGeneCount={0}
      />
    );

    const lanePicker = screen.getByLabelText('Max lanes');
    fireEvent.focus(lanePicker);
    fireEvent.change(lanePicker, { target: { value: '7' } });
    fireEvent.keyDown(lanePicker, { key: 'Escape' });

    expect(onChangeLaneLimit).not.toHaveBeenCalled();
    expect(lanePicker).toHaveValue('2');
    expect(lanePicker).not.toHaveFocus();
  });

  it('maps source-relative cutoff depth logarithmically and keeps simultaneous BAM lanes independent', () => {
    vi.useFakeTimers();
    const changeA = vi.fn();
    const changeB = vi.fn();
    const webglRef = createRef<IndexedGenomeTileNativeMapHandle>();
    webglRef.current = {
      getLinearRenderer: () =>
        ({
          getTrackDiagnostics: (trackId: string) =>
            trackId === 'a'
              ? { coverageDepthP99: 128, coverageDepthMax: 1_388_261 }
              : { coverageDepthP99: 64, coverageDepthMax: 4_096 },
        }) as never,
    } as IndexedGenomeTileNativeMapHandle;
    render(
      <>
        <CoverageCutoffControl
          trackId="a"
          label="A"
          value={0}
          onChange={changeA}
          webglRef={webglRef}
        />
        <CoverageCutoffControl
          trackId="b"
          label="B"
          value={140}
          onChange={changeB}
          webglRef={webglRef}
        />
      </>
    );

    act(() => vi.advanceTimersByTime(250));
    const scaleA = { min: 1, auto: 128, max: 1_388_261 };
    const scaleB = { min: 1, auto: 64, max: 4_096 };
    expect(screen.getByLabelText('Coverage cutoff for A')).toHaveValue(
      String(coverageDepthToSliderPosition(scaleA.auto, scaleA))
    );
    expect(screen.getByLabelText('Coverage cutoff for B')).toHaveValue(
      String(coverageDepthToSliderPosition(140, scaleB))
    );
    expect(screen.getByLabelText('Use automatic coverage cutoff for A')).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByLabelText('Coverage cutoff for A')).toHaveAttribute(
      'aria-valuetext',
      expect.stringContaining('Automatic cutoff 128×')
    );
    expect(screen.getByLabelText('Coverage cutoff for A')).toHaveClass('accent-emerald-600');
    fireEvent.change(screen.getByLabelText('Coverage cutoff for A'), {
      target: { value: '500' },
    });
    expect(changeA).toHaveBeenCalledWith(coverageSliderPositionToDepth(500, scaleA));
    expect(changeB).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('Use automatic coverage cutoff for B'));
    expect(changeB).toHaveBeenCalledWith(0);
    vi.useRealTimers();
  });

  it('maps the complete data range monotonically and places auto at its real depth', () => {
    const scale = coverageDepthScaleFromDiagnostics({
      coverageDepthP99: 128,
      coverageDepthMax: 1_388_261,
    });
    expect(scale).toEqual({ min: 1, auto: 128, max: 1_388_261 });
    expect(coverageSliderPositionToDepth(0, scale!)).toBe(1);
    expect(coverageSliderPositionToDepth(COVERAGE_CUTOFF_SLIDER_MAX, scale!)).toBe(1_388_261);
    expect(coverageDepthToSliderPosition(scale!.auto, scale!)).toBeGreaterThan(0);
    expect(coverageDepthToSliderPosition(scale!.auto, scale!)).toBeLessThan(
      COVERAGE_CUTOFF_SLIDER_MAX
    );
    const depths = [0, 100, 250, 500, 750, 1_000].map((position) =>
      coverageSliderPositionToDepth(position, scale!)
    );
    expect(depths).toEqual([...depths].sort((left, right) => left - right));
  });

  it('chooses a visible transcript carrier for the splice demo instead of child/helper rows', () => {
    const childHelper = feature('exon', 66_200_000, 66_201_500, {
      _resolvedExons: [{ start: 66_200_010, end: 66_200_100 }],
      _resolvedCds: [{ start: 66_200_010, end: 66_200_100 }],
    });
    const transcriptWithoutCds = feature('mRNA', 10_000, 11_500, {
      _resolvedExons: [
        { start: 10_000, end: 10_100 },
        { start: 10_400, end: 10_500 },
        { start: 11_000, end: 11_500 },
      ],
      _resolvedCds: [],
    });
    const renderedTranscript = feature('mRNA', 626_308, 627_181, {
      _resolvedExons: [
        { start: 626_308, end: 626_380 },
        { start: 626_500, end: 626_620 },
        { start: 626_750, end: 626_900 },
        { start: 627_050, end: 627_181 },
      ],
      _resolvedCds: [
        { start: 626_330, end: 626_380 },
        { start: 626_500, end: 626_620 },
      ],
    });

    expect(pickSpliceDemoFeature([childHelper, transcriptWithoutCds, renderedTranscript])).toBe(
      renderedTranscript
    );
  });
});
