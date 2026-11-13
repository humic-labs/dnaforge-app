// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import {
  buildSequencePackageDocument,
  serializeSequencePackageDocument,
} from '../../db/sequence-package';
import { resolveMigrationSequenceDestinationPath } from '../../services/legacy-migration-sequence-destination';

const ROOT = '/workspace';
const INDEXED = '/workspace/Benchling Imports/Canary/Canary.gb';
const PRODUCT = '/workspace/Benchling Imports/Canary/Canary/Canary.gb';
const MARKER = '/workspace/Benchling Imports/Canary/Canary/.forge/plasmid.json';

function validMarker(productFile = 'Canary.gb'): string {
  return serializeSequencePackageDocument(
    buildSequencePackageDocument({
      id: 'benchling-sequence-canary',
      name: 'Canary',
      product: { file: productFile },
      updatedAt: '2026-07-29T00:00:00.000Z',
    })
  );
}

function fileSystem(input: {
  existing?: string[];
  markerText?: string;
  markerBytes?: Uint8Array;
  markerReadError?: Error;
  invalidContainedPath?: string;
  nonFilePath?: string;
}) {
  const existing = new Set(input.existing ?? []);
  const markerText = input.markerText ?? validMarker();
  return {
    exists: vi.fn(async (path: string) => existing.has(path)),
    readFileBounded: vi.fn(async () => {
      if (input.markerReadError) throw input.markerReadError;
      return input.markerBytes ?? new TextEncoder().encode(markerText);
    }),
    stat: vi.fn(async (path: string) =>
      existing.has(path) ? { isFile: path !== input.nonFilePath } : null
    ),
    validateWorkspacePath: vi.fn(
      async ({ path }: { workspaceRoot: string; path: string }) =>
        path !== input.invalidContainedPath
    ),
  };
}

describe('resolveMigrationSequenceDestinationPath', () => {
  it('prefers the immutable indexed path when it still exists', async () => {
    const fs = fileSystem({ existing: [INDEXED] });

    await expect(
      resolveMigrationSequenceDestinationPath({ fs, indexedPath: INDEXED, workspaceRoot: ROOT })
    ).resolves.toBe(INDEXED);
    expect(fs.readFileBounded).not.toHaveBeenCalled();
  });

  it('recovers only the exact validated nested plasmid product from older builds', async () => {
    const fs = fileSystem({ existing: [PRODUCT, MARKER] });

    await expect(
      resolveMigrationSequenceDestinationPath({ fs, indexedPath: INDEXED, workspaceRoot: ROOT })
    ).resolves.toBe(PRODUCT);
    expect(fs.validateWorkspacePath).toHaveBeenCalledWith({
      workspaceRoot: ROOT,
      path: PRODUCT,
      artifactNoun: 'migration destination',
    });
    expect(fs.validateWorkspacePath).toHaveBeenCalledWith({
      workspaceRoot: ROOT,
      path: MARKER,
      artifactNoun: 'migration destination',
    });
  });

  it.each([
    { name: 'missing marker', existing: [PRODUCT] },
    { name: 'missing product', existing: [MARKER] },
  ])('fails closed for a $name', async ({ existing }) => {
    const fs = fileSystem({ existing });

    await expect(
      resolveMigrationSequenceDestinationPath({ fs, indexedPath: INDEXED, workspaceRoot: ROOT })
    ).rejects.toThrow('preserved sequence destination is unavailable');
  });

  it('fails closed when the marker names a different product', async () => {
    const fs = fileSystem({
      existing: [PRODUCT, MARKER],
      markerText: validMarker('Different.gb'),
    });

    await expect(
      resolveMigrationSequenceDestinationPath({ fs, indexedPath: INDEXED, workspaceRoot: ROOT })
    ).rejects.toThrow('marker names a different product');
  });

  it('fails closed when the package marker is malformed', async () => {
    const fs = fileSystem({
      existing: [PRODUCT, MARKER],
      markerText: '{',
    });

    await expect(
      resolveMigrationSequenceDestinationPath({ fs, indexedPath: INDEXED, workspaceRoot: ROOT })
    ).rejects.toThrow();
  });

  it('fails closed before parsing a package marker larger than the bounded read', async () => {
    const fs = fileSystem({
      existing: [PRODUCT, MARKER],
      markerReadError: new Error('File exceeds bounded read limit'),
    });

    await expect(
      resolveMigrationSequenceDestinationPath({ fs, indexedPath: INDEXED, workspaceRoot: ROOT })
    ).rejects.toThrow('bounded read limit');
  });

  it('fails closed when a package member traverses a symlink boundary', async () => {
    const fs = fileSystem({
      existing: [PRODUCT, MARKER],
      invalidContainedPath: PRODUCT,
    });

    await expect(
      resolveMigrationSequenceDestinationPath({ fs, indexedPath: INDEXED, workspaceRoot: ROOT })
    ).rejects.toThrow('outside its project');
  });

  it('derives the same exact compatibility shape for a Windows path', async () => {
    const indexed = 'C:\\workspace\\Benchling Imports\\Canary\\Canary.gbk';
    const product = 'C:\\workspace\\Benchling Imports\\Canary\\Canary\\Canary.gbk';
    const marker = 'C:\\workspace\\Benchling Imports\\Canary\\Canary\\.forge\\plasmid.json';
    const fs = fileSystem({
      existing: [product, marker],
      markerText: validMarker('Canary.gbk'),
    });

    await expect(
      resolveMigrationSequenceDestinationPath({
        fs,
        indexedPath: indexed,
        workspaceRoot: 'C:\\workspace',
      })
    ).resolves.toBe(product);
  });
});
