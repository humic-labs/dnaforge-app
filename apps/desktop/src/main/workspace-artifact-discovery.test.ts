import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverWorkspaceArtifacts } from './workspace-artifact-discovery';

describe('discoverWorkspaceArtifacts', () => {
  let rootPath: string;

  beforeEach(() => {
    rootPath = mkdtempSync(join(tmpdir(), 'dnaforge-artifact-discovery-'));
  });

  afterEach(() => {
    rmSync(rootPath, { recursive: true, force: true });
  });

  it('returns sparse primer/entity candidates and excludes trash and dependency trees', async () => {
    mkdirSync(join(rootPath, 'oligos'), { recursive: true });
    mkdirSync(join(rootPath, 'Lab notes', '.forge'), { recursive: true });
    mkdirSync(join(rootPath, 'records', 'strain'), { recursive: true });
    mkdirSync(join(rootPath, '.waypoint', 'trash'), { recursive: true });
    mkdirSync(join(rootPath, 'node_modules', 'fixture'), { recursive: true });
    writeFileSync(join(rootPath, 'oligos', 'F.primer.json'), '{}\n');
    writeFileSync(join(rootPath, 'Lab notes', '.forge', 'notebook.json'), '{}\n');
    writeFileSync(join(rootPath, 'records', 'strain', 'DH5alpha.entity.json'), '{}\n');
    writeFileSync(join(rootPath, '.waypoint', 'trash', 'deleted.primer.json'), '{}\n');
    writeFileSync(join(rootPath, 'node_modules', 'fixture', 'ignored.primer.json'), '{}\n');
    for (let index = 0; index < 64; index++) {
      writeFileSync(join(rootPath, `irrelevant-${index}.txt`), 'x\n');
    }

    writeFileSync(join(rootPath, 'sequence.gb'), 'LOCUS seq 1 bp DNA\n//\n');

    const result = await discoverWorkspaceArtifacts({
      rootPath,
      knownFiles: [
        {
          path: join(rootPath, 'missing.gb'),
          contentHash: 'sha256:old',
          sizeBytes: 1,
          modifiedAt: 1,
        },
      ],
    });

    expect(result.primerArtifactPaths).toEqual([join(rootPath, 'oligos', 'F.primer.json')]);
    expect(result.entityArtifactPaths).toEqual([
      join(rootPath, 'Lab notes', '.forge', 'notebook.json'),
      join(rootPath, 'records', 'strain', 'DH5alpha.entity.json'),
    ]);
    expect(result.errors).toEqual([]);
    expect(result.scannedEntries).toBeGreaterThan(64);
    expect(result.catalogProjection?.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: join(rootPath, 'sequence.gb'),
          fileKind: 'genbank',
          contentHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        }),
        expect.objectContaining({
          path: join(rootPath, 'Lab notes'),
          fileKind: 'waypoint-notebook',
        }),
      ])
    );
    expect(result.catalogProjection?.missingPaths).toEqual([join(rootPath, 'missing.gb')]);
  });

  it('never marks known files missing when the filesystem traversal is incomplete', async () => {
    const knownPath = join(rootPath, 'still-authoritative.gb');
    rmSync(rootPath, { recursive: true, force: true });

    const result = await discoverWorkspaceArtifacts({
      rootPath,
      knownFiles: [
        {
          path: knownPath,
          contentHash: 'sha256:last-good',
          sizeBytes: 42,
          modifiedAt: 1,
        },
      ],
    });

    expect(result.errors).toEqual([expect.objectContaining({ path: rootPath })]);
    expect(result.catalogProjection?.missingPaths).toEqual([]);
  });

  it('preserves plasmid package boundaries while still finding nested packages', async () => {
    mkdirSync(join(rootPath, 'Outer', '.forge'), { recursive: true });
    mkdirSync(join(rootPath, 'Outer', 'assets', 'Inner', '.forge'), { recursive: true });
    writeFileSync(join(rootPath, 'Outer', '.forge', 'plasmid.json'), '{}\n');
    writeFileSync(join(rootPath, 'Outer', 'Outer.gb'), 'LOCUS Outer 1 bp DNA\n//\n');
    writeFileSync(join(rootPath, 'Outer', 'assets', 'support.fa'), '>support\nA\n');
    writeFileSync(join(rootPath, 'Outer', 'assets', 'Inner', '.forge', 'plasmid.json'), '{}\n');
    writeFileSync(
      join(rootPath, 'Outer', 'assets', 'Inner', 'Inner.gb'),
      'LOCUS Inner 1 bp DNA\n//\n'
    );

    const result = await discoverWorkspaceArtifacts({ rootPath, knownFiles: [] });
    const paths = result.catalogProjection?.candidates.map((candidate) => candidate.path);

    expect(result.entityArtifactPaths).toEqual([
      join(rootPath, 'Outer', '.forge', 'plasmid.json'),
      join(rootPath, 'Outer', 'assets', 'Inner', '.forge', 'plasmid.json'),
    ]);
    expect(paths).not.toContain(join(rootPath, 'Outer', 'Outer.gb'));
    expect(paths).not.toContain(join(rootPath, 'Outer', 'assets', 'Inner', 'Inner.gb'));
    expect(paths).not.toContain(join(rootPath, 'Outer', 'assets', 'support.fa'));
  });

  it('discovers a native protocol package when the package is the workspace root', async () => {
    mkdirSync(join(rootPath, '.forge'), { recursive: true });
    writeFileSync(join(rootPath, '.forge', 'protocol.json'), '{}\n');

    const result = await discoverWorkspaceArtifacts({ rootPath, knownFiles: [] });

    expect(result.catalogProjection?.candidates).toEqual([
      expect.objectContaining({
        path: join(rootPath, '.forge', 'protocol.json'),
        fileKind: 'waypoint-protocol',
      }),
    ]);
  });
});
