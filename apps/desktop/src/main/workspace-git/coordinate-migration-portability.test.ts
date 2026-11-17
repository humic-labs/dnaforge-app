import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  convertTreeToMolecularPackages,
  materializeCoordinatePackage,
} from './coordinate-package-import';
import {
  parseMolecularDocument,
  serializeMolecularDocument,
} from '../../shared/molecular-document';

const ORIGINAL =
  'HEADER    ORIGINAL\nATOM      1  CA  ALA A   1      11.104  13.207   2.100  1.00 20.00           C\nEND\n';
const NEXT_INPUT = ORIGINAL.replace('ORIGINAL', 'NEW INCOMING STRUCTURE');

describe('completed coordinate migration remains portable', () => {
  let directory: string;
  let root: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'dnaforge-coordinate-portability-'));
    root = join(directory, 'original');
    mkdirSync(root);
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('does not replay completed migration or reject later edits after copying a project', async () => {
    const source = join(root, 'model.pdb');
    writeFileSync(source, ORIGINAL);
    const first = await materializeCoordinatePackage(source, { removeSource: unlink });
    expect(first.converted).toBe(true);
    const copiedRoot = join(directory, 'copied');
    cpSync(root, copiedRoot, { recursive: true });
    const product = join(copiedRoot, 'model.dnaforge-molecular.json');
    const document = parseMolecularDocument(readFileSync(product, 'utf8'));
    const edited = serializeMolecularDocument({ ...document, name: 'Later user edit' });
    writeFileSync(product, edited);

    const result = await convertTreeToMolecularPackages(copiedRoot, { removeSource: unlink });

    expect(result.converted).toBe(0);
    expect(result.skipped).toEqual([]);
    expect(readFileSync(product, 'utf8')).toBe(edited);
    expect(
      readdirSync(copiedRoot).filter((name) => name.endsWith('.dnaforge-molecular.json'))
    ).toEqual(['model.dnaforge-molecular.json']);
  });

  it('converts a new arrival at the same pathname without changing the earlier document', async () => {
    const source = join(root, 'model.pdb');
    writeFileSync(source, ORIGINAL);
    const first = await materializeCoordinatePackage(source, { removeSource: unlink });
    expect(first.converted).toBe(true);
    if (!first.converted) throw new Error('Initial conversion did not complete.');
    const firstBytes = readFileSync(first.productPath, 'utf8');
    const firstDocument = parseMolecularDocument(firstBytes);
    writeFileSync(source, NEXT_INPUT);

    const second = await materializeCoordinatePackage(source, { removeSource: unlink });

    expect(second.converted).toBe(true);
    if (!second.converted) throw new Error(second.skippedReason);
    expect(second.productPath).not.toBe(first.productPath);
    const secondDocument = parseMolecularDocument(readFileSync(second.productPath, 'utf8'));
    expect(secondDocument.id).not.toBe(firstDocument.id);
    expect(secondDocument.history[0].snapshot.coordinates.text).toBe(NEXT_INPUT);
    expect(readFileSync(first.productPath, 'utf8')).toBe(firstBytes);
    expect(existsSync(source)).toBe(false);
  });
});
