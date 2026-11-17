import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  convertTreeToMolecularPackages,
  materializeCoordinatePackage,
} from './coordinate-package-import';

const ORIGINAL =
  'HEADER    ORIGINAL\nATOM      1  CA  ALA A   1      11.104  13.207   2.100  1.00 20.00           C\nEND\n';
const EXTERNAL_EDIT = ORIGINAL.replace('ORIGINAL', 'EXTERNAL EDIT');

describe('automatic coordinate migration preserves source ownership', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dnaforge-coordinate-migration-safety-'));
  });

  it('resumes one document identity after interruption between publication and source removal', async () => {
    const source = join(root, 'model.pdb');
    writeFileSync(source, ORIGINAL);
    const runner = join(root, 'interrupt.ts');
    writeFileSync(
      runner,
      `import { materializeCoordinatePackage } from ${JSON.stringify(
        resolve(__dirname, 'coordinate-package-import.ts')
      )};\nawait materializeCoordinatePackage(${JSON.stringify(source)}, {
        removeSource: async () => { process.exit(73); }
      });\n`
    );
    const interrupted = spawnSync(
      resolve(__dirname, '../../../../../node_modules/.bin/vite-node'),
      [runner],
      { encoding: 'utf8', cwd: resolve(__dirname, '../../..') }
    );
    expect(interrupted.error).toBeUndefined();
    expect(interrupted.status, interrupted.stderr).toBe(73);
    const outputPaths = () =>
      readdirSync(root)
        .filter((name) => name.endsWith('.dnaforge-molecular.json'))
        .map((name) => join(root, name));
    expect(outputPaths()).toHaveLength(1);
    const firstPath = outputPaths()[0];
    const firstBytes = readFileSync(firstPath, 'utf8');
    const firstId = JSON.parse(firstBytes).id;

    await materializeCoordinatePackage(source, { removeSource: unlink });

    expect(outputPaths()).toEqual([firstPath]);
    expect(JSON.parse(readFileSync(firstPath, 'utf8')).id).toBe(firstId);
    expect(readFileSync(firstPath, 'utf8')).toBe(firstBytes);
    expect(existsSync(source)).toBe(false);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('retains an external edit made while constructing its molecular document', async () => {
    const source = join(root, 'model.pdb');
    writeFileSync(source, ORIGINAL);
    const removed: string[] = [];

    const result = await materializeCoordinatePackage(source, {
      now: () => {
        writeFileSync(source, EXTERNAL_EDIT);
        return 1000;
      },
      removeSource: async (path) => {
        removed.push(path);
        await unlink(path);
      },
    });

    expect(result.converted).toBe(false);
    expect(existsSync(source)).toBe(true);
    expect(readFileSync(source, 'utf8')).toBe(EXTERNAL_EDIT);
    expect(removed).toEqual([]);
    expect(existsSync(join(root, 'model.dnaforge-molecular.json'))).toBe(false);
  });

  it.each(['plasmid.json', 'notebook.json', 'protocol.json', 'protocol-run.json'])(
    'preserves coordinate members already owned by a %s package',
    async (marker) => {
      const packageRoot = join(root, 'Existing document');
      mkdirSync(join(packageRoot, '.forge'), { recursive: true });
      mkdirSync(join(packageRoot, 'assets'), { recursive: true });
      writeFileSync(join(packageRoot, '.forge', marker), '{"identity":"existing"}\n');
      const member = join(packageRoot, 'assets', 'evidence.pdb');
      writeFileSync(member, ORIGINAL);
      const removed: string[] = [];

      const result = await convertTreeToMolecularPackages(root, {
        removeSource: async (path) => {
          removed.push(path);
          await unlink(path);
        },
      });

      expect(result.converted).toBe(0);
      expect(removed).toEqual([]);
      expect(readFileSync(member, 'utf8')).toBe(ORIGINAL);
      expect(existsSync(join(packageRoot, 'assets', 'evidence.dnaforge-molecular.json'))).toBe(
        false
      );
    }
  );
});
