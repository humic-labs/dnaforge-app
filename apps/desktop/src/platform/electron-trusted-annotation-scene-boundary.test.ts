// @vitest-environment node

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DESKTOP_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER_SRC = resolve(DESKTOP_SRC, '../../../packages/core/genome-renderer/src');
const RENDERER_PACKAGE = resolve(RENDERER_SRC, '../package.json');
const INTERNAL_ENTRY = '@waypoint/genome-renderer/internal/trusted-annotation-scene-transport';

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
  });
}

describe('trusted annotation-scene transport ownership', () => {
  it('allows only Electron transport and the finite scene-admission worker to import the trusted decoder', () => {
    const importers = sourceFiles(DESKTOP_SRC)
      .filter((path) => readFileSync(path, 'utf8').includes(INTERNAL_ENTRY))
      .map((path) => relative(DESKTOP_SRC, path));
    expect(importers).toEqual([
      'main/reference-assets/portable-prepared-reference-scene-admission-worker-job.ts',
      'platform/electron.ts',
    ]);
  });

  it('keeps the raw marker and decoder absent from public renderer barrels', () => {
    for (const barrel of ['index.ts', 'pure.ts']) {
      const source = readFileSync(join(RENDERER_SRC, barrel), 'utf8');
      expect(source).not.toContain('TRUSTED_MAIN_PARTITIONED_TRANSCRIPT_SCENE_VALIDATION_V4');
      expect(source).not.toContain('unpackTrustedMainValidatedPartitionedTranscriptSceneBinaryV4');
    }
  });

  it('exposes one exact internal subpath with no wildcard and no generic binary API', () => {
    const manifest = JSON.parse(readFileSync(RENDERER_PACKAGE, 'utf8')) as {
      exports: Record<string, unknown>;
    };
    expect(manifest.exports).toHaveProperty('./internal/trusted-annotation-scene-transport');
    expect(Object.keys(manifest.exports).filter((key) => key.includes('*'))).toEqual([]);
    const internalSource = readFileSync(
      join(RENDERER_SRC, 'internal/trusted-annotation-scene-transport.ts'),
      'utf8'
    );
    expect(internalSource).toContain(
      'unpackTrustedMainValidatedPartitionedTranscriptSceneBinaryV4'
    );
    expect(internalSource).toContain('scopeTrustedPartitionedTranscriptRendererAdmissionV4');
    expect(internalSource).not.toContain('packGpuReadyPartitionedTranscriptSceneBinaryV4');
    expect(internalSource).not.toContain('unpackPartitionedTranscriptSceneBinaryV4,');
    expect(internalSource).not.toContain('validatePartitionedTranscriptSceneBinaryV4');
  });

  it('rejects desktop production imports of the binary implementation path', () => {
    const importers = sourceFiles(DESKTOP_SRC)
      .filter((path) =>
        readFileSync(path, 'utf8').includes('partitioned-transcript-scene-binary-v4')
      )
      .map((path) => relative(DESKTOP_SRC, path));
    expect(importers).toEqual([]);
  });
});
