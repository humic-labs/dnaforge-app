import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Genome, PrimerHandleHitPayload } from '@waypoint/genome-renderer';
import type { ParsedPlasmid } from '../../types';
import { WebGLMap } from './WebGLMap';
import { primerRenderId } from './plasmid-to-genome';

const capture = vi.hoisted(() => ({
  options: null as null | {
    genome: Genome;
    onPrimerHandleDragCommit?: (handle: PrimerHandleHitPayload, targetBp: number) => void;
  },
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

vi.mock('./use-pixi-map', () => ({
  useHiddenMapIdlePolicy: (fallback: string) => fallback,
  usePixiMap: (options: NonNullable<typeof capture.options>) => {
    capture.options = options;
    return {
      containerRef: { current: null },
      handle: {
        subscribeToPresentedFrames: vi.fn(() => () => {}),
        requestRender: vi.fn(),
      },
    };
  },
}));

afterEach(() => {
  cleanup();
  capture.options = null;
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
