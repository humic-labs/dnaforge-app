import { describe, expect, it, vi } from 'vitest';

import type { CurrentAdmittedTrackSource } from '@waypoint/genome-data';

import { VariantRequestError } from './variant-client';
import { createVariantSourceSession } from './variant-source-session';

const REFERENCES = [{ name: 'chr1', length: 1_000 }] as const;
const PREPARED = {
  sourcePath: '/data/calls.vcf.gz',
  queryPath: '/cache/calls.vcf.gz',
  indexPath: '/cache/calls.vcf.gz.tbi',
  format: 'vcf' as const,
  label: 'calls.vcf.gz',
  sourceSizeBytes: 1_000,
  sourceMtimeNs: '1',
  sourceIdentity: 'a'.repeat(64),
  sourceGeneration: generation('/data/calls.vcf.gz', 1_000),
  queryGeneration: generation('/cache/calls.vcf.gz', 1_000),
  indexGeneration: generation('/cache/calls.vcf.gz.tbi', 100),
  assemblyRevision: `variant-assembly-v1:sha256:${'b'.repeat(64)}`,
  matchedReferences: ['chr1'],
  samples: [],
};

const SOURCE: CurrentAdmittedTrackSource = {
  admissionVersion: 2,
  request: {
    contract: 'dnaforge.track-admission-request.v1',
    assemblyId: 'grch38',
    source: { kind: 'local-file', path: '/data/calls.vcf.gz' },
    formatId: 'vcf',
    scientificKind: 'variants',
    ingress: { kind: 'file-picker' },
  },
  admittedAt: '2026-09-21T20:00:00.000Z',
  uri: 'file:///data/calls.vcf.gz',
  input: { kind: 'path', path: '/data/calls.vcf.gz' },
  formatId: 'vcf',
  recommendedTypes: ['variant'],
  fingerprint: `sha256:${'c'.repeat(64)}`,
  readerKind: 'variant',
  scientificKind: 'variants',
  assemblyId: 'grch38',
  referenceReceipt: {
    assemblyId: 'grch38',
    referenceSignature: `sha256:${'d'.repeat(64)}`,
    sourceSignature: `sha256:${'e'.repeat(64)}`,
    contigMap: { chr1: 'chr1' },
    checkedContigs: 1,
    status: 'compatible',
    checkedAt: '2026-09-21T20:00:00.000Z',
  },
  provenance: { provider: 'local-file', sourceKind: 'local-file', label: 'calls.vcf.gz' },
  expectedValidators: { contentLength: 1_000 },
};

describe('variant source runtime session', () => {
  it('does not query or publish a runtime admitted after the source session was disposed', async () => {
    let finish!: () => void;
    const admit = vi.fn(
      async (input: Parameters<typeof import('./track-admission').admitTrackSource>[0]) => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        input.onVariantRuntime?.({
          runtime: {
            kind: 'local',
            prepared: PREPARED,
            sourceIdentity: PREPARED.sourceIdentity,
            assemblyRevision: PREPARED.assemblyRevision,
            matchedReferences: PREPARED.matchedReferences,
            samples: PREPARED.samples,
          },
        });
        return SOURCE;
      }
    );
    const session = createVariantSourceSession({
      source: SOURCE,
      assemblyReferences: REFERENCES,
      admit,
    });
    const query = vi.fn().mockResolvedValue('retired-result');
    const pending = session.execute(new AbortController().signal, query);
    const outcome = pending.then(
      (value) => ({ value }),
      (error: Error) => ({ error })
    );
    session.dispose();
    finish();
    expect(await outcome).toMatchObject({ error: expect.any(Error) });
    expect(query).not.toHaveBeenCalled();
  });

  it('re-admits once and reuses an immutable local runtime across regional queries', async () => {
    const admit = vi.fn(
      async (input: Parameters<typeof import('./track-admission').admitTrackSource>[0]) => {
        input.onVariantRuntime?.({
          runtime: {
            kind: 'local',
            prepared: PREPARED,
            sourceIdentity: PREPARED.sourceIdentity,
            assemblyRevision: PREPARED.assemblyRevision,
            matchedReferences: PREPARED.matchedReferences,
            samples: PREPARED.samples,
          },
        });
        return SOURCE;
      }
    );
    const session = createVariantSourceSession({
      source: SOURCE,
      assemblyReferences: REFERENCES,
      admit,
    });
    const signal = new AbortController().signal;

    await expect(session.execute(signal, async (runtime) => runtime.sourceIdentity)).resolves.toBe(
      PREPARED.sourceIdentity
    );
    await session.execute(signal, async (runtime) => runtime.assemblyRevision);

    expect(admit).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(SOURCE)).not.toContain('sourceToken');
  });

  it('re-admits exactly once after an expired runtime grant', async () => {
    let token = 0;
    const admit = vi.fn(
      async (input: Parameters<typeof import('./track-admission').admitTrackSource>[0]) => {
        token += 1;
        input.onVariantRuntime?.({
          runtime: {
            format: 'vcf',
            sourceToken: `runtime-${token}`,
            indexToken: `index-${token}`,
            sourceIdentity: PREPARED.sourceIdentity,
            assemblyRevision: PREPARED.assemblyRevision,
            matchedReferences: ['chr1'],
            samples: [],
            grantExpiresAtMs: Date.now() + 60_000,
          },
        });
        return SOURCE;
      }
    );
    const session = createVariantSourceSession({
      source: SOURCE,
      assemblyReferences: REFERENCES,
      admit,
    });
    let queries = 0;
    const result = await session.execute(new AbortController().signal, async (runtime) => {
      queries += 1;
      if (queries === 1) {
        throw new VariantRequestError('expired', { code: 'expired', status: 401 });
      }
      return 'sourceToken' in runtime ? runtime.sourceToken : '';
    });

    expect(result).toBe('runtime-2');
    expect(admit).toHaveBeenCalledTimes(2);
    expect(queries).toBe(2);
  });

  it('prepares again exactly once after the sidecar reports a changed source', async () => {
    let admissions = 0;
    const admit = vi.fn(
      async (input: Parameters<typeof import('./track-admission').admitTrackSource>[0]) => {
        admissions += 1;
        input.onVariantRuntime?.({
          runtime: {
            kind: 'local',
            prepared: { ...PREPARED, queryPath: `/cache/calls-${admissions}.vcf.gz` },
            sourceIdentity: PREPARED.sourceIdentity,
            assemblyRevision: PREPARED.assemblyRevision,
            matchedReferences: PREPARED.matchedReferences,
            samples: PREPARED.samples,
          },
        });
        return SOURCE;
      }
    );
    const session = createVariantSourceSession({
      source: SOURCE,
      assemblyReferences: REFERENCES,
      admit,
    });
    let queries = 0;
    const result = await session.execute(new AbortController().signal, async (runtime) => {
      queries += 1;
      if (queries === 1) {
        throw new VariantRequestError('changed', { code: 'VARIANT_SOURCE_CHANGED', status: 409 });
      }
      return 'prepared' in runtime ? runtime.prepared.queryPath : '';
    });

    expect(result).toBe('/cache/calls-2.vcf.gz');
    expect(admit).toHaveBeenCalledTimes(2);
    expect(queries).toBe(2);
  });

  it('fails closed when re-admission resolves to a different durable identity', async () => {
    const admit = vi.fn(
      async (input: Parameters<typeof import('./track-admission').admitTrackSource>[0]) => {
        input.onVariantRuntime?.({
          runtime: {
            kind: 'local',
            prepared: PREPARED,
            sourceIdentity: PREPARED.sourceIdentity,
            assemblyRevision: PREPARED.assemblyRevision,
            matchedReferences: ['chr1'],
            samples: [],
          },
        });
        return { ...SOURCE, fingerprint: `sha256:${'f'.repeat(64)}` };
      }
    );
    const session = createVariantSourceSession({
      source: SOURCE,
      assemblyReferences: REFERENCES,
      admit,
    });

    await expect(session.execute(new AbortController().signal, async () => null)).rejects.toThrow(
      'changed since it was added'
    );
  });
});

function generation(path: string, size: number) {
  return {
    canonicalPath: path,
    size,
    mtimeNs: '1',
    ctimeNs: '2',
    device: '3',
    inode: '4',
  };
}
