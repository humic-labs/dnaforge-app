import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

describe('expanded annotation-scene worker production surface', () => {
  it('uses electron-vite worker and process entries and remains Pixi/root-renderer/loadGenome free', () => {
    const factory = source('./assembly-expanded-annotation-scene-worker-factory.ts');
    const entry = source('./assembly-expanded-annotation-scene-worker-entry.ts');
    const compiler = source('./assembly-expanded-annotation-scene-compiler.ts');
    const mapper = source('../../shared/indexed-genome-annotation-feature-mapper.ts');
    const featurePipeline = source(
      '../../features/sequence/assembly-annotation-feature-pipeline.ts'
    );
    const legacyAdapter = source(
      '../../features/sequence/components/indexed-genome-legacy-adapter.ts'
    );
    const production = `${entry}\n${compiler}\n${mapper}\n${featurePipeline}\n${legacyAdapter}`;

    expect(factory).toContain('?nodeWorker');
    expect(factory).toContain('?modulePath');
    expect(entry).toContain("parentPort?.once('message'");
    expect(entry).toContain("process.on('message'");
    expect(production).not.toContain("from 'pixi.js'");
    expect(production).not.toContain("from '@waypoint/genome-renderer'");
    expect(production).not.toMatch(/\bloadGenome\b/);
    expect(compiler).toContain("from '@waypoint/genome-renderer/pure'");
  });

  it('leaves payload validation to exactly one cache-writer trust boundary', () => {
    const compiler = source('./assembly-expanded-annotation-scene-compiler.ts');
    const cache = source('./assembly-overview-texture-cache.ts');
    const writerStart = cache.indexOf('export async function writeAssemblyAnnotationSceneCache');
    const writerEnd = cache.indexOf('\nexport ', writerStart + 1);
    const writer = cache.slice(writerStart, writerEnd < 0 ? cache.length : writerEnd);

    expect(compiler).not.toMatch(/await validatePartitionedTranscriptSceneBinaryV4\s*\(/);
    expect(
      writer.match(/await validatePartitionedTranscriptSceneBinaryV4\s*\(/g) ?? []
    ).toHaveLength(1);
  });

  it('keeps reusable scene readiness independent from the background broad raster product', () => {
    const compiler = source('./assembly-expanded-annotation-scene-compiler.ts');
    const cache = `${source('./assembly-overview-texture-cache.ts')}\n${source(
      '../../shared/annotation-scene-compiler-contract.ts'
    )}`;
    const sceneCompilerStart = compiler.indexOf(
      'export async function compileAndCommitExpandedAnnotationSceneWorkerJob'
    );
    const sceneSetCompilerStart = compiler.indexOf(
      'export async function compileAndCommitExpandedAnnotationSceneWorkerSetJob'
    );
    const sceneCompiler = compiler.slice(sceneCompilerStart, sceneSetCompilerStart);
    const sceneSetCompiler = compiler.slice(sceneSetCompilerStart);

    expect(sceneCompilerStart).toBeGreaterThan(0);
    expect(sceneSetCompilerStart).toBeGreaterThan(sceneCompilerStart);
    expect(sceneCompiler).toContain('const writeSceneCache = deps.writeSceneCache');
    expect(sceneCompiler).not.toContain('compileAndPublishBroadRasterArtifactForPackedScene(');
    expect(sceneSetCompiler).toContain('compileAndPublishBroadRasterArtifactForPackedScene');
    expect(cache).toContain('assembly-annotation-scene-compiler-cache.direct-bank-v4.v1');
    expect(cache).not.toContain('direct-bank-v4-with-broad-raster');
  });
});
