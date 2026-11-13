import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { AssemblyProteinSearchWorkerJob } from './assembly-protein-search-build';
import { compileSearchChromosomesInWorkersV1 } from './assembly-search-chromosome-pool';

const dir = mkdtempSync(join(tmpdir(), 'search-chromosome-pool-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const log = join(dir, 'dispatch.log');
const entry = join(dir, 'entry.cjs');
writeFileSync(
  entry,
  `const { appendFileSync } = require('node:fs');
   let job;
   process.on('message', (request) => {
     if (request.job) job = request.job;
     appendFileSync(${JSON.stringify(log)}, request.index + (request.job ? '+job' : '') + '\\n');
     if (job.request.chromosomes[request.index].chrom === 'bad') {
       process.send({ id: request.id, error: { name: 'Error', message: 'bad chromosome' } });
     } else {
       process.send({ id: request.id, result: job.request.chromosomes[request.index].chrom });
     }
   });`
);

function job(
  chromosomes: Array<{ chrom: string; length: number }>
): AssemblyProteinSearchWorkerJob {
  return { request: { chromosomes } } as unknown as AssemblyProteinSearchWorkerJob;
}

describe('compileSearchChromosomesInWorkersV1', () => {
  it('returns results in request order, dispatching the largest chromosomes first', async () => {
    const chromosomes = [
      { chrom: 'small', length: 10 },
      { chrom: 'large', length: 1_000 },
      { chrom: 'medium', length: 100 },
    ];
    const results = await compileSearchChromosomesInWorkersV1<string>(
      entry,
      'protein',
      job(chromosomes),
      [0, 1, 2],
      undefined,
      1
    );
    expect(results).toEqual(['small', 'large', 'medium']);
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['1+job', '2', '0']);
  });

  it('rejects when any chromosome fails', async () => {
    await expect(
      compileSearchChromosomesInWorkersV1(
        entry,
        'annotation',
        job([
          { chrom: 'good', length: 5 },
          { chrom: 'bad', length: 5 },
        ]),
        [0, 1],
        undefined,
        2
      )
    ).rejects.toThrow('bad chromosome');
  });
});
