import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssemblyAnnotationRasterReadResultV2 } from '../../../shared/indexed-genome';
import type { AssemblyAnnotationPolicyRequest } from './assembly-annotation-policy-transaction';
import {
  assemblyAnnotationRasterReadRequest,
  useAssemblyAnnotationRaster,
  useAssemblyAnnotationRasterHandoff,
} from './useAssemblyAnnotationRaster';

const { readRaster } = vi.hoisted(() => ({ readRaster: vi.fn() }));

vi.mock('../../../platform', () => ({
  platform: () => ({
    genome: {
      readAssemblyAnnotationRasterV2: readRaster,
    },
  }),
}));

const sourceRequest = {
  assemblyId: 'grch38',
  workspaceRoot: '/workspace',
  chromosomes: [{ chrom: 'chr1', sourcePath: '/workspace/chr1.gff3.gz', length: 100 }],
};
const descriptor = {
  sourceIdentity: `assembly-annotation-source-sha256.v1:${'a'.repeat(64)}`,
  datasetContract: {
    datasetId: 'waypoint:assembly-annotation:grch38',
    datasetVersion: 'resolved-transcript-v2',
    sourceSha256: 'a'.repeat(64),
  },
};

function rasterResult(label: string): AssemblyAnnotationRasterReadResultV2 {
  return {
    pngBase64: label,
    manifest: {
      widthPx: 8192,
      heightPx: 128,
      resolution: 2,
      spineOffsetPx: 127,
      genomeLength: 100,
      maxAnnotationLane: 367,
      maxCdsLane: -1,
      layerTypes: ['mRNA'],
    },
  } as AssemblyAnnotationRasterReadResultV2;
}

describe('useAssemblyAnnotationRaster', () => {
  beforeEach(() => {
    readRaster.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds an exact policy-aware request tied to the active source identity', () => {
    expect(
      assemblyAnnotationRasterReadRequest({
        sourceRequest,
        descriptor,
        isoformMode: 'expanded',
        laneLimit: 8,
        themeMode: 'light',
      })
    ).toEqual({
      ...sourceRequest,
      datasetContract: descriptor.datasetContract,
      genomeIdentity: descriptor.sourceIdentity,
      trackType: 'mRNA',
      isoformMode: 'expanded',
      laneLimit: 8,
      themeMode: 'light',
    });
  });

  it('reports an exact projection miss without invoking a renderer fallback compiler', async () => {
    readRaster.mockResolvedValueOnce(null);
    const { result } = renderHook(() =>
      useAssemblyAnnotationRaster({
        sourceRequest,
        descriptor,
        isoformMode: 'expanded',
        laneLimit: 8,
        themeMode: 'light',
      })
    );

    await waitFor(() => expect(result.current.status).toBe('miss'));
    expect(result.current.texture).toBeNull();
    expect(readRaster).toHaveBeenCalledOnce();
    expect(readRaster.mock.calls[0]?.[0]).toMatchObject({
      isoformMode: 'expanded',
      laneLimit: 8,
    });
  });

  it('decodes the bounded PNG with the persisted bottom-up orientation corrected once', async () => {
    const image = { width: 16_384, height: 256, close: vi.fn() } as unknown as ImageBitmap;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ blob: vi.fn().mockResolvedValue({}) }));
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(image));
    readRaster.mockResolvedValueOnce({
      pngBase64: 'bounded-png',
      manifest: {
        widthPx: 8192,
        heightPx: 128,
        resolution: 2,
        spineOffsetPx: 127,
        genomeLength: 100,
        maxAnnotationLane: 367,
        maxCdsLane: -1,
        layerTypes: ['mRNA'],
      },
    } as AssemblyAnnotationRasterReadResultV2);

    const { result } = renderHook(() =>
      useAssemblyAnnotationRaster({
        sourceRequest,
        descriptor,
        isoformMode: 'expanded',
        laneLimit: 8,
        themeMode: 'light',
      })
    );

    await waitFor(() => expect(result.current.status).toBe('loaded'));
    expect(createImageBitmap).toHaveBeenCalledWith(expect.anything(), {
      imageOrientation: 'flipY',
    });
    expect(result.current.texture?.image).toBe(image);
  });

  it('retains the committed raster while a pending policy decodes, then promotes it without rereading', async () => {
    let resolvePending!: (value: AssemblyAnnotationRasterReadResultV2) => void;
    const pendingRead = new Promise<AssemblyAnnotationRasterReadResultV2>((resolve) => {
      resolvePending = resolve;
    });
    const committedImage = {
      width: 16_384,
      height: 384,
      close: vi.fn(),
    } as unknown as ImageBitmap;
    const pendingImage = {
      width: 16_384,
      height: 768,
      close: vi.fn(),
    } as unknown as ImageBitmap;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ blob: vi.fn().mockResolvedValue({}) }));
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockResolvedValueOnce(committedImage).mockResolvedValueOnce(pendingImage)
    );
    readRaster.mockResolvedValueOnce(rasterResult('canonical-12')).mockReturnValueOnce(pendingRead);

    const { result, rerender } = renderHook(
      ({
        committedPolicy,
        pendingRequest,
      }: {
        committedPolicy: { isoformMode: 'canonical' | 'expanded'; laneLimit: number | null };
        pendingRequest: AssemblyAnnotationPolicyRequest | null;
      }) =>
        useAssemblyAnnotationRasterHandoff({
          sourceRequest,
          descriptor,
          committedPolicy,
          pendingRequest,
          themeMode: 'light',
        }),
      {
        initialProps: {
          committedPolicy: { isoformMode: 'canonical' as const, laneLimit: 12 },
          pendingRequest: null,
        },
      }
    );

    await waitFor(() => expect(result.current.renderer.status).toBe('loaded'));
    expect(result.current.renderer.texture?.image).toBe(committedImage);

    rerender({
      committedPolicy: { isoformMode: 'canonical', laneLimit: 12 },
      pendingRequest: {
        requestId: 1,
        policy: { isoformMode: 'expanded', laneLimit: 24 },
      },
    });
    expect(result.current.renderer.texture?.image).toBe(committedImage);
    expect(result.current.pendingPreparation).toMatchObject({
      requestId: 1,
      policy: { isoformMode: 'expanded', laneLimit: 24 },
      status: 'loading',
    });

    resolvePending(rasterResult('expanded-24'));
    await waitFor(() => expect(result.current.pendingPreparation?.status).toBe('ready'));
    expect(result.current.renderer.texture?.image).toBe(pendingImage);
    expect(committedImage.close).not.toHaveBeenCalled();

    rerender({
      committedPolicy: { isoformMode: 'expanded', laneLimit: 24 },
      pendingRequest: null,
    });
    await waitFor(() => expect(committedImage.close).toHaveBeenCalledOnce());
    expect(result.current.renderer.texture?.image).toBe(pendingImage);
    expect(readRaster).toHaveBeenCalledTimes(2);
  });

  it('retries the exact same policy when a new preparation request follows a miss', async () => {
    const committedImage = {
      width: 16_384,
      height: 384,
      close: vi.fn(),
    } as unknown as ImageBitmap;
    const retryImage = {
      width: 16_384,
      height: 768,
      close: vi.fn(),
    } as unknown as ImageBitmap;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ blob: vi.fn().mockResolvedValue({}) }));
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockResolvedValueOnce(committedImage).mockResolvedValueOnce(retryImage)
    );
    readRaster
      .mockResolvedValueOnce(rasterResult('canonical-12'))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(rasterResult('expanded-24-retry'));

    const pendingPolicy = { isoformMode: 'expanded' as const, laneLimit: 24 };
    const { result, rerender } = renderHook(
      ({ pendingRequest }: { pendingRequest: AssemblyAnnotationPolicyRequest | null }) =>
        useAssemblyAnnotationRasterHandoff({
          sourceRequest,
          descriptor,
          committedPolicy: { isoformMode: 'canonical', laneLimit: 12 },
          pendingRequest,
          themeMode: 'light',
        }),
      { initialProps: { pendingRequest: null as AssemblyAnnotationPolicyRequest | null } }
    );

    await waitFor(() => expect(result.current.renderer.status).toBe('loaded'));
    rerender({ pendingRequest: { requestId: 41, policy: pendingPolicy } });
    await waitFor(() => expect(result.current.pendingPreparation?.status).toBe('miss'));
    expect(result.current.pendingPreparation).toMatchObject({
      requestId: 41,
      policy: pendingPolicy,
    });

    rerender({ pendingRequest: { requestId: 42, policy: pendingPolicy } });
    await waitFor(() => expect(result.current.pendingPreparation?.status).toBe('ready'));
    expect(result.current.pendingPreparation).toMatchObject({
      requestId: 42,
      policy: pendingPolicy,
    });
    expect(result.current.renderer.texture?.image).toBe(retryImage);
    expect(readRaster).toHaveBeenCalledTimes(3);
  });

  it('keeps only C authoritative when decoded A and B complete after rapid A to B to C requests', async () => {
    let resolveA!: (image: ImageBitmap) => void;
    let resolveB!: (image: ImageBitmap) => void;
    const decodeA = new Promise<ImageBitmap>((resolve) => {
      resolveA = resolve;
    });
    const decodeB = new Promise<ImageBitmap>((resolve) => {
      resolveB = resolve;
    });
    const committedImage = { close: vi.fn() } as unknown as ImageBitmap;
    const imageA = { close: vi.fn() } as unknown as ImageBitmap;
    const imageB = { close: vi.fn() } as unknown as ImageBitmap;
    const imageC = { close: vi.fn() } as unknown as ImageBitmap;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        blob: async () => ({ label: url }),
      }))
    );
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn((blob: { label?: string }) => {
        if (blob.label?.includes('canonical-12')) return Promise.resolve(committedImage);
        if (blob.label?.includes('expanded-8')) return decodeA;
        if (blob.label?.includes('expanded-16')) return decodeB;
        return Promise.resolve(imageC);
      })
    );
    readRaster
      .mockResolvedValueOnce(rasterResult('canonical-12'))
      .mockResolvedValueOnce(rasterResult('expanded-8'))
      .mockResolvedValueOnce(rasterResult('expanded-16'))
      .mockResolvedValueOnce(rasterResult('expanded-24'));

    const { result, rerender } = renderHook(
      ({ pendingRequest }: { pendingRequest: AssemblyAnnotationPolicyRequest | null }) =>
        useAssemblyAnnotationRasterHandoff({
          sourceRequest,
          descriptor,
          committedPolicy: { isoformMode: 'canonical', laneLimit: 12 },
          pendingRequest,
          themeMode: 'light',
        }),
      { initialProps: { pendingRequest: null as AssemblyAnnotationPolicyRequest | null } }
    );
    await waitFor(() => expect(result.current.renderer.texture?.image).toBe(committedImage));

    rerender({
      pendingRequest: { requestId: 101, policy: { isoformMode: 'expanded', laneLimit: 8 } },
    });
    await waitFor(() => expect(createImageBitmap).toHaveBeenCalledTimes(2));
    rerender({
      pendingRequest: { requestId: 102, policy: { isoformMode: 'expanded', laneLimit: 16 } },
    });
    await waitFor(() => expect(createImageBitmap).toHaveBeenCalledTimes(3));
    rerender({
      pendingRequest: { requestId: 103, policy: { isoformMode: 'expanded', laneLimit: 24 } },
    });

    await waitFor(() => expect(result.current.pendingPreparation?.status).toBe('ready'));
    expect(result.current.pendingPreparation).toMatchObject({
      requestId: 103,
      policy: { isoformMode: 'expanded', laneLimit: 24 },
    });
    expect(result.current.renderer.texture?.image).toBe(imageC);

    resolveA(imageA);
    resolveB(imageB);
    await waitFor(() => {
      expect(imageA.close).toHaveBeenCalledOnce();
      expect(imageB.close).toHaveBeenCalledOnce();
    });
    expect(result.current.pendingPreparation).toMatchObject({
      requestId: 103,
      status: 'ready',
    });
    expect(result.current.renderer.texture?.image).toBe(imageC);
  });
});
