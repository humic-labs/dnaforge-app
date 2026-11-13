import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { deriveAssemblyPrepackedAnnotationSceneDescriptor } from '../../features/sequence/assembly-annotation-product-descriptor';

const source = (relativePath: string): string =>
  readFileSync(resolve(__dirname, relativePath), 'utf8');

describe('assembly annotation product index IPC surface', () => {
  it('exposes only read-only product admission across renderer boundaries', () => {
    const main = source('./genome-data.ts');
    const preload = source('../../preload/indexed-genome-ipc.ts');
    const declarations = source('../../preload/index.d.ts');
    const platform = source('../../platform/types.ts');
    const electron = source('../../platform/electron.ts');
    const browserMock = source('../../platform/browser-mock.ts');
    const assetFactory = source('../reference-assets/create-assembly-reference-asset-service.ts');

    expect(main).toContain("'genome:readAssemblyAnnotationProductSetInventoryV1'");
    expect(preload).toContain(
      "rendererIpc.invoke('genome:readAssemblyAnnotationProductSetInventoryV1', input)"
    );
    for (const sourceText of [preload, declarations, platform, electron, browserMock]) {
      expect(sourceText).not.toContain('scheduleAssemblyAnnotationProductSetIndexV1');
      expect(sourceText).not.toContain('scheduleAssemblyAnnotationProductIndexV1');
      expect(sourceText).not.toContain('prepareAssemblyAnnotationScene');
    }
    expect(main).not.toContain("'genome:scheduleAssemblyAnnotationProductSetIndexV1'");
    expect(main).not.toContain("'genome:scheduleAssemblyAnnotationProductIndexV1'");
    expect(main).not.toContain("'genome:prepareAssemblyAnnotationScene'");
    expect(main).toContain('createAssemblyReferenceAssetAuthoritiesV1({');
    expect(main).not.toContain('new AssemblyAnnotationProductIndexCoordinatorV1');
    const coordinatorStart = assetFactory.indexOf(
      'const productIndex = new AssemblyAnnotationProductIndexCoordinatorV1'
    );
    const coordinatorEnd = assetFactory.indexOf('\n  });', coordinatorStart);
    const coordinator = assetFactory.slice(coordinatorStart, coordinatorEnd);
    expect(coordinator).toContain('readAssemblyAnnotationSceneCacheIndex(request');
    expect(coordinator).toContain('broadRasterPreparation.ensureSceneHit(hit)');
    expect(coordinator).not.toContain('readAssemblyAnnotationSceneCacheResource(request');
  });

  it('admits at both pre-tab and restored-tab boundaries without compiling', () => {
    const openAssembly = source('../../features/sequence/openAssembly.ts');
    const preparation = source('../../features/sequence/prepareAssemblyAnnotationProductSet.ts');
    const indexedViewer = source('../../features/sequence/components/IndexedGenomeViewer.tsx');
    const indexedTab = source('../../features/sequence/components/IndexedGenomeTab.tsx');

    expect(preparation).toContain(
      'await platform().genome.readAssemblyAnnotationProductSetInventoryV1'
    );
    expect(preparation).not.toContain('scheduleAssemblyAnnotationProductSetIndexV1');
    expect(preparation).not.toContain('platform().genome.open');
    expect(preparation).not.toContain('platform().genome.getAnnotationTile');
    expect(indexedViewer).not.toContain('scheduleAssemblyAnnotationProductSetIndexV1');
    expect(indexedTab).not.toContain('scheduleAssemblyAnnotationProductSetIndexV1');
    const productAdmission = openAssembly.indexOf('const ordinaryProductAdmission =');
    const mountCall = openAssembly.indexOf('return mountOpenAssemblyTab({', productAdmission);
    const mountHelper = openAssembly.indexOf('function mountOpenAssemblyTab(');
    const presentation = openAssembly.indexOf(': presentDocument(', mountHelper);
    expect(productAdmission).toBeGreaterThan(-1);
    expect(mountCall).toBeGreaterThan(productAdmission);
    expect(presentation).toBeGreaterThan(mountHelper);
    const restoredPreparation = indexedTab.indexOf(
      'await prepareCurrentAssemblyAnnotationProductSet(assembly'
    );
    expect(restoredPreparation).toBeGreaterThan(-1);
    expect(restoredPreparation).toBeLessThan(
      indexedTab.indexOf('await platform().genome.open(source)')
    );
  });

  it('keeps runtime policy absent from immutable product identity', async () => {
    const input = {
      request: {
        assemblyId: 'grch38',
        workspaceRoot: '/workspace',
        scope: {
          kind: 'viewport-subset' as const,
          placements: [{ chrom: 'chr1', length: 100, annotationCoverage: 'sourced' as const }],
        },
        chromosomes: [{ chrom: 'chr1', sourcePath: '/workspace/chr1.gff3', length: 100 }],
      },
      themeMode: 'light' as const,
      policy: { trackType: 'mRNA', isoformMode: 'canonical' as const, laneLimit: 12 },
    };
    const canonical = await deriveAssemblyPrepackedAnnotationSceneDescriptor(input);
    for (const policy of [
      { isoformMode: 'expanded' as const, laneLimit: 12 },
      { isoformMode: 'canonical' as const, laneLimit: null },
    ]) {
      const descriptor = await deriveAssemblyPrepackedAnnotationSceneDescriptor({
        ...input,
        policy: { ...input.policy, ...policy },
      });
      expect(descriptor).toMatchObject({
        sourceIdentity: canonical.sourceIdentity,
        placementFingerprint: canonical.placementFingerprint,
        datasetContract: canonical.datasetContract,
        artifact: canonical.artifact,
        sceneKey: canonical.sceneKey,
        runtimeCacheKey: canonical.runtimeCacheKey,
      });
      expect(descriptor.request.requestedPolicy).toEqual(policy);
    }
  });
});
