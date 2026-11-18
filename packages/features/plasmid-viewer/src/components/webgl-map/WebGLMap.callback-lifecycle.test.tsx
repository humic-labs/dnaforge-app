import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Genome, PrimerHandleHitPayload, TrackHitResult } from '@waypoint/genome-renderer';
import type { ParsedPlasmid } from '../../types';
import { WebGLMap } from './WebGLMap';
import { primerRenderId } from './plasmid-to-genome';

const capture = vi.hoisted(() => ({
  options: null as null | {
    genome: Genome;
    circular?: boolean;
    onRendererReady?: () => void;
    onPrimerHandleDragCommit?: (handle: PrimerHandleHitPayload, targetBp: number) => void;
  },
  transitionLifecycle: false,
  renderer: null as Record<string, unknown> | null,
  finishRendererInit: null as (() => void) | null,
  setTrackHitHandler: vi.fn(),
  state: { highlightRange: null as [number, number] | null },
  requestRender: vi.fn(),
  setViewCenter: vi.fn(),
  setCameraViewport: vi.fn(),
}));

vi.mock('@waypoint/genome-renderer', async () => ({
  ...(await import('../../../../../core/genome-renderer/src/primer-render-conventions')),
  ...(await import('../../../../../core/genome-renderer/src/feature-colors')),
  genomeFeatures: (genome: Genome) => genome.features ?? [],
  perfLog: vi.fn(),
  perfMark: vi.fn(),
  recordWebGLSelectionDebug: vi.fn(),
}));

vi.mock('@waypoint/genome-renderer/react', () => ({
  pixiInitOptionsForPerformanceMode: vi.fn(),
  resolveWebGLPerformanceMode: () => 'default',
  WEBGL_PERFORMANCE_PREFERENCES: ['auto'],
}));

vi.mock('./use-pixi-map', async () => {
  const { useEffect } = await import('react');
  return {
    useHiddenMapIdlePolicy: (fallback: string) => fallback,
    usePixiMap: (options: NonNullable<typeof capture.options>) => {
      capture.options = options;
      useEffect(() => {
        if (!capture.transitionLifecycle) return;
        capture.renderer = options.circular ? {} : null;
        capture.finishRendererInit = () => {
          capture.renderer = { setTrackHitHandler: capture.setTrackHitHandler };
          options.onRendererReady?.();
        };
        return () => {
          capture.renderer = null;
          capture.finishRendererInit = null;
        };
      }, [options.circular]);
      return {
        containerRef: { current: null },
        handle: {
          getLinearRenderer: () => (capture.options?.circular ? null : capture.renderer),
          getState: () => capture.state,
          subscribeToPresentedFrames: vi.fn(() => () => {}),
          requestRender: capture.requestRender,
          setViewCenter: capture.setViewCenter,
          setCameraViewport: capture.setCameraViewport,
        },
      };
    },
  };
});

afterEach(() => {
  cleanup();
  capture.options = null;
  capture.transitionLifecycle = false;
  capture.renderer = null;
  capture.finishRendererInit = null;
  capture.state.highlightRange = null;
  vi.clearAllMocks();
});

function fixture(): ParsedPlasmid {
  return {
    name: 'circular assembly callback lifecycle',
    length: 120,
    circular: true,
    sequence: 'ATGC'.repeat(30),
    features: [
      {
        type: 'promoter',
        start: 1,
        end: 30,
        direction: 'forward',
        qualifiers: {},
        displayName: 'Assembly promoter',
        color: '#2563eb',
      },
    ],
    primers: [
      {
        id: 'assembly-primer',
        name: 'Assembly primer',
        start: 30,
        end: 50,
        direction: 'forward',
        bases: 'ATGC'.repeat(5),
        tm: 55,
        gc: 50,
        mismatches: [],
        hasExplicitSequence: true,
      },
    ],
  };
}

it('waits for the linear renderer before attaching track hits after a circular topology change', () => {
  capture.transitionLifecycle = true;
  const plasmid = fixture();
  const onSelectionChange = vi.fn();
  const { rerender, unmount } = render(
    <WebGLMap plasmid={plasmid} circular onSelectionChange={onSelectionChange} />
  );
  expect(capture.renderer).toEqual({});
  expect(capture.setTrackHitHandler).not.toHaveBeenCalled();
  rerender(<WebGLMap plasmid={plasmid} circular={false} onSelectionChange={onSelectionChange} />);
  expect(capture.renderer).toBeNull();
  expect(capture.setTrackHitHandler).not.toHaveBeenCalled();
  act(() => capture.finishRendererInit?.());
  expect(capture.setTrackHitHandler).toHaveBeenCalledTimes(1);
  const hit = capture.setTrackHitHandler.mock.calls[0][0] as (result: TrackHitResult) => void;
  act(() => hit({ kind: 'select-bp-range', startBp: 12, endBp: 18, chromosomeId: 'fixture' }));
  expect(capture.state.highlightRange).toEqual([12, 17]);
  expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith(12, 17, false);
  expect(capture.requestRender).toHaveBeenCalled();
  act(() => hit({ kind: 'jump-to-bp', bp: 35 }));
  expect(capture.setViewCenter).toHaveBeenCalledExactlyOnceWith(35);
  act(() => hit({ kind: 'frame-bp-range', startBp: 30, endBp: 50, chromosomeId: 'fixture' }));
  expect(capture.setCameraViewport).toHaveBeenCalledExactlyOnceWith(30, 50);
  unmount();
  expect(capture.setTrackHitHandler).toHaveBeenLastCalledWith(null);
});

it('keeps installed circular assembly data when an editing callback is replaced', () => {
  const plasmid = fixture();
  const firstCallback = vi.fn();
  const nextCallback = vi.fn();
  const { rerender } = render(
    <WebGLMap
      plasmid={plasmid}
      width={320}
      height={966}
      geometryHeight={600}
      circular
      morphToCircle={0}
      onPrimerPbsEndpointCommit={firstCallback}
    />
  );
  const installed = capture.options!.genome;
  expect(installed.features).toHaveLength(1);
  expect(installed.primers?.[0].editablePbsEndpoint).toBe(true);

  rerender(
    <WebGLMap
      plasmid={plasmid}
      width={320}
      height={966}
      geometryHeight={600}
      circular
      morphToCircle={1}
      onPrimerPbsEndpointCommit={nextCallback}
    />
  );
  const next = capture.options!;
  act(() =>
    next.onPrimerHandleDragCommit?.({ id: primerRenderId(0) } as PrimerHandleHitPayload, 55)
  );
  expect(firstCallback).not.toHaveBeenCalled();
  expect(nextCallback).toHaveBeenCalledExactlyOnceWith(plasmid.primers[0], 55);
  expect(next.genome).toBe(installed);
});

it('rebuilds editable primer data when editing availability changes', () => {
  const plasmid = fixture();
  const { rerender } = render(<WebGLMap plasmid={plasmid} circular />);
  const readOnly = capture.options!.genome;
  expect(readOnly.primers?.[0].editablePbsEndpoint).toBe(false);

  rerender(<WebGLMap plasmid={plasmid} circular onPrimerPbsEndpointCommit={vi.fn()} />);
  const editable = capture.options!.genome;
  expect(editable).not.toBe(readOnly);
  expect(editable.primers?.[0].editablePbsEndpoint).toBe(true);

  rerender(<WebGLMap plasmid={plasmid} circular />);
  expect(capture.options!.genome).not.toBe(editable);
  expect(capture.options!.genome.primers?.[0].editablePbsEndpoint).toBe(false);
});
