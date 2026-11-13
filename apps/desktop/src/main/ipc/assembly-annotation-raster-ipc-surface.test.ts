import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import {
  assemblyAnnotationSceneScopeForRequest,
  type AssemblyAnnotationRasterReadRequestV2,
  type AssemblyOverviewChromInput,
} from '../../shared/indexed-genome';
import { deriveAssemblyPrepackedAnnotationSceneDescriptor } from '../../features/sequence/components/useAssemblyPrepackedAnnotationSceneCache';
import { readAssemblyAnnotationRasterCacheV2 } from './assembly-overview-texture-cache';
import { isMissingOrGitLfsPointerFixture } from '../../test/fixture-availability';

const source = (relativePath: string): string =>
  readFileSync(resolve(__dirname, relativePath), 'utf8');
const GENERATED_GRCH38_WORKSPACE_ROOT = resolve(__dirname, '../../../../../test-fixtures');
const GENERATED_GRCH38_ARTIFACT_DIR = resolve(
  GENERATED_GRCH38_WORKSPACE_ROOT,
  '.waypoint/genome-index/assembly-overview'
);
const GENERATED_GRCH38_SOURCE_MANIFEST_FILE =
  'grch38-f364add98d1dae8d4ebfba37-45dfcf8970dca3fe7cfb.annotation-raster.v2.json';
const GENERATED_GRCH38_SOURCE_MANIFEST_PATH = resolve(
  GENERATED_GRCH38_ARTIFACT_DIR,
  GENERATED_GRCH38_SOURCE_MANIFEST_FILE
);

const GENERATED_GRCH38_EXPANDED_12_UNAVAILABLE = isMissingOrGitLfsPointerFixture(
  GENERATED_GRCH38_SOURCE_MANIFEST_PATH
);
const itGeneratedGrch38 = GENERATED_GRCH38_EXPANDED_12_UNAVAILABLE ? it.skip : it;

describe('assembly annotation-raster V2 product surface', () => {
  it('registers one read-only main handler with path safety and runtime build identity', () => {
    const main = source('./genome-data.ts');
    const start = main.indexOf("'genome:readAssemblyAnnotationRasterV2'");
    const end = main.indexOf('\n  mainIpc.handle(', start);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const handler = main.slice(start, end);
    expect(handler).toContain('readAssemblyAnnotationRasterCacheV2(input');
    expect(handler).toContain('assertSafePath');
    expect(handler).toContain('sourceBuildFingerprint: __WAYPOINT_BUILD_SOURCE_FINGERPRINT__');
    expect(handler).toContain('return null');
    expect(handler).not.toMatch(/\bwrite(?:File|Assembly|Texture|Cache)\b/);
    expect(handler).not.toContain('sharp');
    expect(handler).not.toContain('compile');
    expect(handler).not.toContain('crop');
  });

  it('exposes the exact invoke through preload and forwards it through Electron unchanged', () => {
    const preload = source('../../preload/indexed-genome-ipc.ts');
    const electron = source('../../platform/electron.ts');
    const platform = source('../../platform/types.ts');

    expect(preload).toContain("rendererIpc.invoke('genome:readAssemblyAnnotationRasterV2', input)");
    expect(electron).toContain(
      'readAssemblyAnnotationRasterV2: (request) =>\n      api().genome.readAssemblyAnnotationRasterV2(request)'
    );
    expect(platform).toContain(
      'readAssemblyAnnotationRasterV2(\n      request: AssemblyAnnotationRasterReadRequestV2\n    ): Promise<AssemblyAnnotationRasterReadResultV2 | null>'
    );
  });

  it('keeps browser raster reads explicit misses and separates exact detail admission from broad presentation', () => {
    const browser = source('../../platform/browser-mock.ts');
    const tab = source('../../features/sequence/components/IndexedGenomeTab.tsx');
    const viewer = source('../../features/sequence/components/IndexedGenomeViewer.tsx');
    const compiledTrack = source(
      '../../features/sequence/components/AssemblyCompiledAnnotationTrack.tsx'
    );

    expect(browser).toContain('readAssemblyAnnotationRasterV2: async () => null');
    expect(browser).toContain('readAssemblyCompiledBroadRasterManifestV1: async () => null');
    expect(browser).toContain('readAssemblyCompiledBroadRasterCellsV1: async () => ({');
    expect(tab).toContain('const interactionPayloadEnabled = assemblySourceReady;');
    expect(tab).toContain(
      'interactionPayloadEnabled:\n      assemblyAnnotationProductsReady &&\n      !fullAssemblyReadinessRequired &&\n      interactionPayloadEnabled'
    );
    expect(tab).toContain('requireFullAssemblyReadiness={fullAssemblyReadinessRequired}');
    expect(tab).not.toContain('annotationRasterHandoff');
    expect(compiledTrack).toContain('useAssemblyCompiledBroadRasterSurface({');
    expect(viewer).toContain('if (liveRendererHasPresentedCompiledBroadRaster(webglRef.current))');
    expect(viewer).toContain('onCompiledBroadRasterVisualReadyRef.current?.()');
  });

  itGeneratedGrch38(
    'admits the real full-GRCh38 expanded/12 projection with the production request identity',
    async () => {
      const workspaceRoot = GENERATED_GRCH38_WORKSPACE_ROOT;
      const artifactDir = GENERATED_GRCH38_ARTIFACT_DIR;
      const sourceManifestFile = GENERATED_GRCH38_SOURCE_MANIFEST_FILE;
      const sourceManifest = JSON.parse(
        readFileSync(resolve(artifactDir, sourceManifestFile), 'utf8')
      ) as { placementSignature: string };
      const chromosomes: AssemblyOverviewChromInput[] = sourceManifest.placementSignature
        .split('\n')
        .slice(2)
        .map((line) => {
          const [, chrom, , , lengthText] = line.split('|');
          const length = Number(lengthText);
          return {
            chrom,
            length,
            sourcePath: resolve(workspaceRoot, 'sources/ncbi-gff3', `${chrom}.gff3.gz`),
          };
        });
      const sourceRequest = {
        assemblyId: 'grch38',
        workspaceRoot,
        chromosomes,
        scope: assemblyAnnotationSceneScopeForRequest('complete-assembly', chromosomes),
      };
      const descriptor = await deriveAssemblyPrepackedAnnotationSceneDescriptor({
        request: sourceRequest,
        themeMode: 'light',
        policy: { trackType: 'mRNA', isoformMode: 'expanded', laneLimit: 12 },
      });
      const request: AssemblyAnnotationRasterReadRequestV2 = {
        assemblyId: sourceRequest.assemblyId,
        workspaceRoot,
        chromosomes,
        datasetContract: descriptor.datasetContract,
        genomeIdentity: descriptor.sourceIdentity,
        trackType: 'mRNA',
        isoformMode: 'expanded',
        themeMode: 'light',
        laneLimit: 12,
      };

      const result = await readAssemblyAnnotationRasterCacheV2(request, {
        assertSafePath: async () => undefined,
      });

      expect(descriptor.datasetContract.sourceSha256).toBe(
        'd2dab109aa66a64ef1ba10108ed020a1018669790bbf219bc30b4848fa19d1b8'
      );
      expect(result).not.toBeNull();
      expect(result?.manifest.rasterVariant).toMatchObject({
        trackType: 'mRNA',
        isoformMode: 'expanded',
        themeMode: 'light',
      });
      expect(result?.manifest.laneProjection).toMatchObject({
        laneLimit: 12,
        sourceMaxAnnotationLane: 367,
        presentedHeightPx: 192,
      });
      expect(result?.manifest.semanticReceipt).toMatchObject({
        genomeIdentity: descriptor.sourceIdentity,
        sourceFingerprint: '0346032526ec1ea6ac0a0b27',
        laneLimit: null,
        maxAnnotationLane: 367,
      });
      expect(result?.pngBase64.length).toBeGreaterThan(10_000_000);
    }
  );
});
