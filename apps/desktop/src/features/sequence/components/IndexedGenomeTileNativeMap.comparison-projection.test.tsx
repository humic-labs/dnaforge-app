import { act, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { parseGenomeComparisonPaf } from '@waypoint/genome-data';
import {
  comparisonColumnLoci,
  createComparisonProjection,
  type ComparisonCamera,
  type ContactCamera,
} from '@waypoint/genome-renderer/pure';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IndexedGenomeTileNativeMap,
  type IndexedGenomeTileNativeMapHandle,
} from './IndexedGenomeTileNativeMap';

const pixi = vi.hoisted(() => ({
  options: null as Record<string, unknown> | null,
  camera: null as ComparisonCamera | null,
  contactCamera: null as ContactCamera | null,
  setContactCamera: vi.fn(),
  setCamera: vi.fn(),
  render: vi.fn(),
}));
vi.mock('@waypoint/genome-renderer/react', async (original) => {
  const actual = await original<typeof import('@waypoint/genome-renderer/react')>();
  return {
    ...actual,
    useIndexedPixiMap: (options: Record<string, unknown>) => {
      pixi.options = options;
      return {
        containerRef: { current: null },
        handle: {
          getState: () => ({
            comparisonProjection: options.comparisonProjection,
            contactProjection: options.contactProjection,
            selectedComparison: null,
          }),
          getContactCamera: () => pixi.contactCamera,
          setContactCamera: (camera: ContactCamera) => {
            pixi.setContactCamera(camera);
            pixi.contactCamera = camera;
            return camera;
          },
          getComparisonCamera: () => pixi.camera,
          setComparisonCamera: (camera: ComparisonCamera) => {
            pixi.setCamera(camera);
            pixi.camera = camera;
            return camera;
          },
          requestRender: pixi.render,
          getLinearRenderer: () => null,
          subscribeToPresentedFrames: () => () => {},
        },
      };
    },
  };
});

const projection = createComparisonProjection({
  id: 'comparison',
  comparison: parseGenomeComparisonPaf(
    'query\t12\t0\t12\t+\ttarget\t10\t0\t10\t10\t12\t60\tcg:Z:5=2I5=\tnn:i:0',
    { target: { id: 'target', length: 10 }, query: { id: 'query', length: 12 } }
  ),
});
const genome = { name: 'target', length: 10, circular: false, features: [] };
const savedCamera = { projectionId: 'comparison', startColumn: 5.5, endColumn: 8.5 };

beforeEach(() => {
  pixi.options = null;
  pixi.camera = null;
  pixi.contactCamera = null;
  pixi.setContactCamera.mockClear();
  pixi.setCamera.mockClear();
});

describe('comparison on the existing indexed native map', () => {
  it('retains the exact contact axes when restoring the integer biological viewport', () => {
    const ref = createRef<IndexedGenomeTileNativeMapHandle>();
    const contactCamera = {
      projectionId: 'contacts',
      xStart: 1.25,
      xEnd: 7.75,
      yStart: 2.5,
      yEnd: 9.25,
    };
    render(
      <IndexedGenomeTileNativeMap
        ref={ref}
        genome={genome}
        themeMode="light"
        width={900}
        height={600}
        contactProjection={{
          kind: 'contact-matrix',
          id: 'contacts',
          xReference: { id: 'target', chrom: 'target', length: 10 },
          yReference: { id: 'query', chrom: 'query', length: 12 },
          cells: [],
          colorScale: {
            kind: 'continuous',
            domain: [0, 1],
            colors: ['#000000', '#ffffff'],
            missingColor: '#cccccc',
            transform: 'linear',
          },
        }}
        contactCamera={contactCamera}
      />
    );
    act(() => {
      expect(ref.current?.setViewport({ start: 1, end: 8 })).toEqual({ start: 1.25, end: 7.75 });
    });
    expect(pixi.contactCamera).toEqual(contactCamera);
    expect(pixi.setContactCamera).toHaveBeenCalledTimes(1);
  });

  it('preserves an exact saved column camera when the normal reference owner restores its corresponding biological viewport', () => {
    const ref = createRef<IndexedGenomeTileNativeMapHandle>();
    render(
      <IndexedGenomeTileNativeMap
        ref={ref}
        genome={genome}
        themeMode="light"
        width={900}
        height={600}
        comparisonProjection={projection}
        comparisonCamera={savedCamera}
      />
    );
    expect(screen.getByTestId('indexed-genome-webgl-map')).toHaveAttribute(
      'data-projection',
      'aligned-comparison'
    );
    expect(ref.current?.getViewportRange()).toEqual({ start: 5, end: 7 });
    act(() => {
      expect(ref.current?.setViewport({ start: 5, end: 7 })).toEqual({ start: 5, end: 7 });
    });
    expect(pixi.camera).toEqual(savedCamera);
    expect(pixi.setCamera).toHaveBeenCalledTimes(1);
    act(() => {
      ref.current?.setViewport({ start: 1, end: 4 });
    });
    expect(pixi.camera).toEqual({ projectionId: 'comparison', startColumn: 1, endColumn: 4 });
  });

  it('uses the existing contextual tooltip for both true loci and a CIGAR gap', () => {
    render(
      <IndexedGenomeTileNativeMap
        genome={genome}
        themeMode="light"
        width={900}
        height={600}
        comparisonProjection={projection}
        comparisonCamera={savedCamera}
      />
    );
    const hit = { ...comparisonColumnLoci(projection, 5)!, side: 'target' as const };
    act(() => {
      (pixi.options?.onComparisonHover as (value: typeof hit) => void)(hit);
    });
    expect(screen.getByTestId('indexed-comparison-tooltip')).toHaveTextContent(
      'target · gap after base 5'
    );
    expect(screen.getByTestId('indexed-comparison-tooltip')).toHaveTextContent('query:6');
    expect(screen.queryByTestId('indexed-contact-tooltip')).not.toBeInTheDocument();
  });
});
