import { preferCurrentThread } from '../thread-scheduling.cjs';
import { realpath } from 'node:fs/promises';

import {
  compileAssemblyAnnotationSearchChromosomeV1,
  readIndexedSourceAnnotations,
  type AssemblyAnnotationSearchWorkerJob,
} from './assembly-annotation-search-compiler';
import { createAuthorizedExpandedAnnotationSourcePathGuard } from './assembly-expanded-annotation-scene-compiler';
import {
  compileAssemblyProteinSearchChromosomeV1,
  openLocalChromosomeSource,
  type AssemblyProteinSearchWorkerJob,
  type ChromosomeSource,
} from './assembly-protein-search-build';
import type {
  PairedSearchChromosomeResultV1,
  SearchChromosomeRequestV1,
  SearchJobV1,
  SearchJobPairV1,
} from './assembly-search-chromosome-pool';

preferCurrentThread('userInitiated');

if (!process.send) {
  throw new Error('Search chromosome process started without an IPC channel.');
}
const send = process.send.bind(process);
const jobs = new Map<string, SearchJobV1>();

process.on('message', (request: SearchChromosomeRequestV1) => {
  if (request.job) jobs.set(request.jobKey, request.job);
  void compile(request).then(
    (result) => send({ id: request.id, result }),
    (error: unknown) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      send({
        id: request.id,
        error: { name: normalized.name, message: normalized.message },
      });
    }
  );
});

async function compile(request: SearchChromosomeRequestV1): Promise<unknown> {
  const job = jobs.get(request.jobKey);
  if (!job) throw new Error('Search chromosome process received an unknown job.');
  if (request.kind === 'both') return compileBoth(job as SearchJobPairV1, request.index);
  const single = job as AssemblyAnnotationSearchWorkerJob | AssemblyProteinSearchWorkerJob;
  const assertSafePath = createAuthorizedExpandedAnnotationSourcePathGuard(
    single.authorizedSourceRealPaths,
    realpath
  );
  return request.kind === 'protein'
    ? compileAssemblyProteinSearchChromosomeV1(
        job as AssemblyProteinSearchWorkerJob,
        request.index,
        { assertSafePath }
      )
    : compileAssemblyAnnotationSearchChromosomeV1(
        job as AssemblyAnnotationSearchWorkerJob,
        request.index,
        { assertSafePath }
      );
}

async function compileBoth(
  pair: SearchJobPairV1,
  index: number
): Promise<PairedSearchChromosomeResultV1> {
  const opened = new Map<string, Promise<ChromosomeSource>>();
  const openShared = (
    manifest: Parameters<typeof openLocalChromosomeSource>[0],
    chrom: string,
    length: number
  ): Promise<ChromosomeSource> => {
    const key = manifest.gffPath ?? '';
    let source = opened.get(key);
    if (!source) {
      source = openLocalChromosomeSource(manifest, chrom, length);
      opened.set(key, source);
    }
    return source;
  };
  const chromosome = pair.annotation.request.chromosomes[index];
  try {
    const annotation = await settle(() =>
      compileAssemblyAnnotationSearchChromosomeV1(pair.annotation, index, {
        assertSafePath: createAuthorizedExpandedAnnotationSourcePathGuard(
          pair.annotation.authorizedSourceRealPaths,
          realpath
        ),
        readIndexedSourceAnnotations: (entry, readRequest, assertSafePath, authorized) =>
          readIndexedSourceAnnotations(entry, readRequest, assertSafePath, authorized, (manifest) =>
            openShared(manifest, chromosome.chrom, chromosome.length).then(
              (source) => source.resolvedAnnotations
            )
          ),
      })
    );
    const protein = await settle(() =>
      compileAssemblyProteinSearchChromosomeV1(pair.protein, index, {
        assertSafePath: createAuthorizedExpandedAnnotationSourcePathGuard(
          pair.protein.authorizedSourceRealPaths,
          realpath
        ),
        openChromosomeSource: (manifest, chrom, length) =>
          openShared(manifest, chrom, length).then((source) => ({
            ...source,
            close: async () => undefined,
          })),
      })
    );
    return { annotation, protein };
  } finally {
    for (const source of opened.values()) {
      await source.then((open) => open.close()).catch(() => undefined);
    }
  }
}

async function settle<T>(
  run: () => Promise<T>
): Promise<{ value: T } | { error: { name: string; message: string } }> {
  try {
    return { value: await run() };
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    return { error: { name: normalized.name, message: normalized.message } };
  }
}
