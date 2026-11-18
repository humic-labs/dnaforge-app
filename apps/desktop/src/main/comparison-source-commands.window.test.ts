import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreparedReferenceAssemblyEntryV1 } from '../shared/reference-assets-ipc';
import {
  comparisonSourceProjectionId,
  type ComparisonSourceWindowRequest,
} from '../shared/comparison-source';
import { ComparisonSourceCommands } from './comparison-source-commands';

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dnaforge-comparison-window-')));
  folders.push(root);
  const paf = 'puc19\t2686\t2000\t2010\t-\tpuc19\t2686\t180\t190\t10\t10\t60\tcg:Z:10=\n';
  const path = join(root, 'comparison.paf');
  await writeFile(path, paf);
  const identity = { sequenceIdentity: 'a'.repeat(64), annotationIdentity: 'b'.repeat(64) };
  const source: ComparisonSourceWindowRequest['source'] = {
    schema: 'dnaforge.comparison-source.v1',
    path: 'comparison.paf',
    sha256: createHash('sha256').update(paf).digest('hex'),
    targetReference: { id: 'puc19', chrom: 'puc19', length: 2686 },
    queryReference: { id: 'puc19', chrom: 'puc19', length: 2686 },
    targetSource: { referenceId: 'prepared-target', ...identity },
    querySource: { referenceId: 'prepared-query', ...identity },
  };
  const request: ComparisonSourceWindowRequest = {
    project: root,
    source,
    camera: { projectionId: comparisonSourceProjectionId(source), startColumn: 1, endColumn: 9 },
  };
  const base = resolve(import.meta.dirname, '../../../../test-fixtures/indexed/pUC19');
  const manifest = {
    fastaPath: join(base, 'pUC19.fa'),
    faiPath: join(base, 'pUC19.fa.fai'),
    gffPath: join(base, 'pUC19.gff3.gz'),
    tbiPath: join(base, 'pUC19.gff3.gz.tbi'),
  };
  const referenceRead = vi.fn();
  const afterReferenceRead = vi.fn(async () => undefined);
  const withReference = async <T>(
    id: string,
    use: (entry: PreparedReferenceAssemblyEntryV1) => Promise<T>
  ): Promise<T> => {
    referenceRead(id);
    const result = await use({
      id,
      referenceIdentity: identity,
      name: id,
      organism: id,
      description: '',
      assetCacheKey: id,
      members: [{ chrom: 'puc19', lengthBp: 2686, manifest }],
    });
    await afterReferenceRead();
    return result;
  };
  const assertCurrent = vi.fn();
  const commands = new ComparisonSourceCommands({
    resolveProject: async (project) => {
      if (project !== root) throw new Error('PROJECT_NOT_ADMITTED');
      return root;
    },
    captureReadable: () => assertCurrent,
    references: { withReference },
  });
  return { root, path, paf, request, referenceRead, afterReferenceRead, assertCurrent, commands };
}

describe('comparison native window command boundary', () => {
  it('reads native prepared source ranges through the saved PAF and preserves its cached alignment', async () => {
    const f = await fixture();
    const comparison = await f.commands.read({ project: f.root, source: f.request.source });
    const result = await f.commands.readWindow(f.request);
    const sequence = (
      await readFile(
        resolve(import.meta.dirname, '../../../../test-fixtures/indexed/pUC19/pUC19.fa'),
        'utf8'
      )
    )
      .split(/\r?\n/u)
      .filter((line) => line && !line.startsWith('>'))
      .join('')
      .toUpperCase();
    expect(result.targetSequenceWindows).toEqual([
      { start: 181, sequence: sequence.slice(181, 189) },
    ]);
    expect(result.querySequenceWindows).toEqual([
      { start: 2001, sequence: sequence.slice(2001, 2009) },
    ]);
    expect(f.referenceRead.mock.calls.map(([id]) => id)).toEqual([
      'prepared-target',
      'prepared-query',
    ]);
    expect(await f.commands.read({ project: f.root, source: f.request.source })).toBe(comparison);
  });

  it('refuses a changed PAF before a prepared source read even after the old comparison was cached', async () => {
    const f = await fixture();
    await f.commands.read({ project: f.root, source: f.request.source });
    await writeFile(f.path, `${f.paf}\n`);
    await expect(f.commands.readWindow(f.request)).rejects.toThrow('fingerprint');
    expect(f.referenceRead).not.toHaveBeenCalled();
  });

  it('refuses a PAF replacement during source resolution and fences the original read authority', async () => {
    const f = await fixture();
    f.afterReferenceRead.mockImplementation(async () => {
      await writeFile(f.path, `${f.paf}\n`);
    });
    await expect(f.commands.readWindow(f.request)).rejects.toThrow('fingerprint');
    const revoked = await fixture();
    revoked.afterReferenceRead.mockImplementation(async () => {
      revoked.assertCurrent.mockImplementation(() => {
        throw new Error('PROJECT_READ_REVOKED');
      });
    });
    await expect(revoked.commands.readWindow(revoked.request)).rejects.toThrow(
      'PROJECT_READ_REVOKED'
    );
  });
});
