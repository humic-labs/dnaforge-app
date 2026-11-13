import { act, cleanup, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useLaneContractStore } from '../lane-contract-store';
import type { IndexedGenomeTileNativeMapHandle } from './IndexedGenomeTileNativeMap';
import { IndexedQuantitativeTrackAxes } from './IndexedQuantitativeTrackAxes';

const OWNER_ID = 'axis-owner';
const TRACK_ID = 'axis-signal';

beforeEach(() => {
  useLaneContractStore.getState().clear();
  useLaneContractStore.getState().addLane(OWNER_ID, 'grch38', {
    trackType: 'quantitative',
    trackId: TRACK_ID,
    label: 'Axis signal',
    color: 0x3b82f6,
    trackPx: 96,
    records: [],
    kind: 'annotation',
    quantitativePresentation: {
      version: 1,
      graph: 'bar',
      showRange: true,
      scale: { mode: 'full-global', transform: 'log1p' },
    },
    quantitativeSourceSummary: {
      contract: 'dnaforge.quantitative-source-summary.v1',
      algorithm: 'equal-genomic-bin-means-r7-quantiles-v1',
      targetSampleCount: 65_536,
      sampleCount: 1_000,
      lowerQuantile: 0.005,
      upperQuantile: 0.995,
      robustMin: 0,
      robustMax: 12,
      fullMin: 0,
      fullMax: 99,
      missingData: 'excluded',
    },
  });
});

afterEach(() => {
  cleanup();
  useLaneContractStore.getState().clear();
});

describe('IndexedQuantitativeTrackAxes', () => {
  it('does not subscribe to presented frames when no quantitative axis is visible', () => {
    useLaneContractStore.getState().clear();
    const subscribeToPresentedFrames = vi.fn(() => () => undefined);
    const webglRef = createRef<IndexedGenomeTileNativeMapHandle | null>();
    webglRef.current = {
      subscribeToPresentedFrames,
      getLinearRenderer: () =>
        ({
          getPresentedTrackScrollReceipt: () => ({
            completedFrameEpoch: 4,
            trackScrollTop: 0,
          }),
        }) as never,
    } as IndexedGenomeTileNativeMapHandle;

    render(
      <IndexedQuantitativeTrackAxes
        laneOwnerId={OWNER_ID}
        bands={{ dataBounds: {} }}
        rendererReadyEpoch={1}
        webglRef={webglRef}
      />
    );

    expect(screen.queryByTestId('quantitative-y-axis-layer')).toBeNull();
    expect(subscribeToPresentedFrames).not.toHaveBeenCalled();
  });

  it('renders inside the canvas at the presented track band and follows scale changes', () => {
    let diagnostics = {
      displayMin: 0,
      displayMax: 99,
      scaleTransform: 'log1p',
      scaleMode: 'full-global',
    };
    const webglRef = createRef<IndexedGenomeTileNativeMapHandle | null>();
    webglRef.current = {
      subscribeToPresentedFrames: vi.fn(() => () => undefined),
      getLinearRenderer: () =>
        ({
          getTrackDiagnostics: () => diagnostics,
          getPresentedTrackScrollReceipt: () => ({
            completedFrameEpoch: 4,
            trackScrollTop: 40,
          }),
        }) as never,
    } as IndexedGenomeTileNativeMapHandle;

    render(
      <div data-testid="indexed-genome-canvas-host">
        <IndexedQuantitativeTrackAxes
          laneOwnerId={OWNER_ID}
          bands={{
            dataBounds: { [TRACK_ID]: { topPx: 300, heightPx: 96 } },
          }}
          rendererReadyEpoch={1}
          webglRef={webglRef}
        />
      </div>
    );

    const canvasHost = screen.getByTestId('indexed-genome-canvas-host');
    const axis = screen.getByTestId(`quantitative-y-axis-${TRACK_ID}`);
    const band = screen.getByTestId(`quantitative-y-axis-band-${TRACK_ID}`);
    expect(canvasHost.contains(axis)).toBe(true);
    expect(band).toHaveStyle({ top: '300px', height: '96px' });
    expect(screen.getByTestId('quantitative-y-axis-scroll-layer')).toHaveStyle({
      transform: 'translate3d(0, -40px, 0)',
    });
    expect(axis).toHaveAttribute('data-scale-transform', 'log1p');
    expect(axis).toHaveAttribute('data-tick-count', '6');
    expect(screen.queryByText('log')).toBeNull();

    diagnostics = { ...diagnostics, scaleTransform: 'linear' };
    act(() => {
      useLaneContractStore.getState().updateLanePresentation(OWNER_ID, TRACK_ID, {
        quantitative: {
          version: 1,
          graph: 'bar',
          showRange: true,
          scale: { mode: 'full-global', transform: 'linear' },
        },
      });
    });

    expect(axis).toHaveAttribute('data-scale-transform', 'linear');
    expect(screen.queryByText('linear')).toBeNull();
  });
});
