import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import {
  ASSEMBLY_COMPILED_BROAD_RASTER_MAX_CELLS_PER_IPC_RESPONSE_V1,
  isAssemblyCompiledBroadRasterSingleCellBatchV1,
} from '../../shared/indexed-genome';

const source = (relativePath: string): string =>
  readFileSync(resolve(__dirname, relativePath), 'utf8');

describe('compiled broad raster background IPC lifecycle', () => {
  it('constructs exactly one production preparation coordinator singleton', () => {
    const main = source('./genome-data.ts');
    const factory = source('../reference-assets/create-assembly-reference-asset-service.ts');
    expect(main.match(/createAssemblyReferenceAssetAuthoritiesV1\(/g)).toHaveLength(1);
    expect(
      factory.match(/new AssemblyCompiledBroadRasterPreparationOrchestratorV1\(/g)
    ).toHaveLength(1);
  });

  it('keeps interaction-scene reads consumption-only', () => {
    const main = source('./genome-data.ts');
    const start = main.indexOf("'genome:readAssemblyAnnotationScene'");
    const end = main.indexOf("'genome:queryAssemblyAnnotationSearch'", start);
    const handler = main.slice(start, end);

    expect(handler).toContain(
      'return { ...metadata, resource, ...(colorRoles ? { colorRoles } : {}) }'
    );
    expect(handler).not.toContain('compiledBroadRasterPreparation');
    expect(handler).not.toContain('scheduleSceneHit');
  });

  it('admits a main-sealed catalog and repairs integrity-failed cell payloads', () => {
    const main = source('./genome-data.ts');
    const manifestStart = main.indexOf("'genome:readAssemblyCompiledBroadRasterManifestV1'");
    const cellsStart = main.indexOf(
      "'genome:readAssemblyCompiledBroadRasterCellsV1'",
      manifestStart
    );
    const cellsEnd = main.indexOf(
      "'genome:readAssemblyAnnotationProductSetInventoryV1'",
      cellsStart
    );
    const manifestHandler = main.slice(manifestStart, cellsStart);
    const cellsHandler = main.slice(cellsStart, cellsEnd);

    expect(manifestHandler).toContain('assemblyAnnotationGenerationAuthorityV1(input.scene)');
    expect(manifestHandler).toContain("generationAuthority === 'mismatch'");
    expect(manifestHandler).toContain('openAssemblyCompiledBroadRasterCatalogV1(input');
    expect(manifestHandler).not.toContain('compiledBroadRasterPreparation');
    expect(manifestHandler).toContain(
      'compiledBroadRasterCatalogCapabilities.issue(event.sender.id, opening)'
    );
    expect(manifestHandler).toContain('catalogReceipt: issued.catalogReceipt');
    expect(manifestHandler).toContain('catalogCapability: issued.catalogCapability');
    expect(manifestHandler).not.toContain('surfaceManifestFingerprint: input');
    expect(cellsHandler).toContain('isRepairableCompiledBroadRasterFailure(error)');
    expect(cellsHandler).toContain('compiledBroadRasterCatalogCapabilities.resolve(');
    expect(cellsHandler).toContain(
      'compiledBroadRasterCatalogCapabilities.invalidate(admitted.catalogCapability)'
    );
    expect(cellsHandler).toContain(
      'compiledBroadRasterPreparation.repairKnownCorruptArtifact(repairInput)'
    );
    expect(cellsHandler).toContain("status: 'ready' as const");
    expect(cellsHandler).toContain('compiledBroadRasterCellsRepairState(');
    expect(cellsHandler).toContain("compiledBroadRasterCellsUnavailable('catalog-stale')");
    expect(cellsHandler).toContain("compiledBroadRasterCellsUnavailable('artifact-io-failure')");
    expect(cellsHandler).not.toContain('Uint8Array.from(premultipliedRgba)');
    expect(cellsHandler).not.toContain('openCurrentCompiledBroadRasterArtifact');
    expect(cellsHandler).not.toContain('computeAssemblyAnnotationSceneSourceFingerprint');
    expect(cellsHandler).not.toContain('readAssemblyAnnotationSceneCache');
    expect(cellsHandler).not.toContain('return null');
    expect(source('./compiled-broad-raster-artifact.ts')).not.toContain('Uint8Array.from(decoded)');
  });

  it('hard-enforces the one-cell transport contract on both request and response', () => {
    expect(ASSEMBLY_COMPILED_BROAD_RASTER_MAX_CELLS_PER_IPC_RESPONSE_V1).toBe(1);
    expect(isAssemblyCompiledBroadRasterSingleCellBatchV1([])).toBe(false);
    expect(isAssemblyCompiledBroadRasterSingleCellBatchV1([{}])).toBe(true);
    expect(isAssemblyCompiledBroadRasterSingleCellBatchV1([{}, {}])).toBe(false);

    const main = source('./genome-data.ts');
    const cellsStart = main.indexOf("'genome:readAssemblyCompiledBroadRasterCellsV1'");
    const cellsEnd = main.indexOf(
      "'genome:readAssemblyAnnotationProductSetInventoryV1'",
      cellsStart
    );
    const handler = main.slice(cellsStart, cellsEnd);
    expect(handler).toContain('isAssemblyCompiledBroadRasterSingleCellBatchV1(input?.addresses)');
    expect(handler).toContain(
      'cells.length !== ASSEMBLY_COMPILED_BROAD_RASTER_MAX_CELLS_PER_IPC_RESPONSE_V1'
    );
  });

  it('never labels an unknown I/O failure as a repairable owned job', () => {
    const main = source('./genome-data.ts');
    const cellsStart = main.indexOf("'genome:readAssemblyCompiledBroadRasterCellsV1'");
    const cellsEnd = main.indexOf(
      "'genome:readAssemblyAnnotationProductSetInventoryV1'",
      cellsStart
    );
    const cellsHandler = main.slice(cellsStart, cellsEnd);
    const genericCatch = cellsHandler.slice(cellsHandler.lastIndexOf('} catch (error)'));

    expect(genericCatch).toContain('isRepairableCompiledBroadRasterFailure(error)');
    expect(genericCatch).toContain("compiledBroadRasterCellsUnavailable('artifact-io-failure')");
    expect(
      genericCatch.lastIndexOf("compiledBroadRasterCellsUnavailable('artifact-io-failure')")
    ).toBeGreaterThan(genericCatch.lastIndexOf('compiledBroadRasterCellsRepairState('));
  });

  it('exposes the discriminated cell lifecycle through preload and both platforms', () => {
    const declarations = source('../../preload/index.d.ts');
    const platform = source('../../platform/types.ts');
    const electron = source('../../platform/electron.ts');
    const browser = source('../../platform/browser-mock.ts');

    expect(declarations).toMatch(
      /readAssemblyCompiledBroadRasterManifestV1\([\s\S]*?request: AssemblyCompiledBroadRasterManifestRequestV1/
    );
    expect(platform).toMatch(
      /readAssemblyCompiledBroadRasterManifestV1\([\s\S]*?request: AssemblyCompiledBroadRasterManifestRequestV1/
    );
    expect(declarations).not.toMatch(
      /readAssemblyCompiledBroadRasterManifestV1\([\s\S]*?request: AssemblyCompiledBroadRasterArtifactRequestV1/
    );
    expect(declarations).toMatch(
      /readAssemblyCompiledBroadRasterCellsV1\([\s\S]*?Promise<AssemblyCompiledBroadRasterCellsResultV1>;/
    );
    expect(platform).toMatch(
      /readAssemblyCompiledBroadRasterCellsV1\([\s\S]*?Promise<AssemblyCompiledBroadRasterCellsResultV1>;/
    );
    expect(electron).toContain('api().genome.readAssemblyCompiledBroadRasterCellsV1(request)');
    expect(browser).toContain("status: 'unavailable' as const");
    expect(browser).toContain("reason: 'repair-not-known' as const");
  });
});
