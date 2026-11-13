// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  AssemblySessionRegistry,
  DEFAULT_ASSEMBLY_SESSION_CAP,
  type AssemblySessionChromConfig,
  type AssemblySessionDriver,
} from './assembly-session-registry';
import type { GenomeSessionShell, IndexedGenomeManifest } from '../../../shared/indexed-genome';

function manifest(chrom: string): IndexedGenomeManifest {
  return { chrom, gffPath: `/tmp/${chrom}.gff3.gz` } as unknown as IndexedGenomeManifest;
}

function chromConfig(chrom: string): AssemblySessionChromConfig {
  return {
    chrom,
    source: { sourcePath: `/tmp/${chrom}.gff3.gz`, chrom },
    manifest: manifest(chrom),
  };
}

function makeDriver(opts?: { openDelayResolvers?: boolean }) {
  const opened: string[] = [];
  const closed: string[] = [];
  const cancelled: Array<{ sessionId: string; requestId: string }> = [];
  let liveCount = 0;
  let peakLive = 0;
  let sessionSeq = 0;
  const pendingOpens: Array<() => void> = [];

  const driver: AssemblySessionDriver = {
    open: (source) => {
      opened.push(source.chrom as string);
      const sessionId = `sess-${source.chrom}-${++sessionSeq}`;
      const shell: GenomeSessionShell = {
        sessionId,
        sourcePath: source.sourcePath,
        sourceFingerprint: `fp-${source.chrom}`,
        chrom: source.chrom as string,
        coordinateReady: true,
        validationState: 'valid' as GenomeSessionShell['validationState'],
        tracks: [],
        openedAt: 0,
      };
      liveCount += 1;
      peakLive = Math.max(peakLive, liveCount);
      if (opts?.openDelayResolvers) {
        return new Promise<GenomeSessionShell>((resolve) => {
          pendingOpens.push(() => resolve(shell));
        });
      }
      return Promise.resolve(shell);
    },
    closeSession: (sessionId) => {
      closed.push(sessionId);
      liveCount -= 1;
      return Promise.resolve();
    },
    cancel: (sessionId, requestId) => {
      cancelled.push({ sessionId, requestId });
    },
  };

  return {
    driver,
    opened,
    closed,
    cancelled,
    flushOpens: () => {
      const fns = pendingOpens.splice(0);
      for (const fn of fns) fn();
    },
    get liveCount() {
      return liveCount;
    },
    get peakLive() {
      return peakLive;
    },
  };
}

const GRCH38_24 = [
  'chr1',
  'chr2',
  'chr3',
  'chr4',
  'chr5',
  'chr6',
  'chr7',
  'chr8',
  'chr9',
  'chr10',
  'chr11',
  'chr12',
  'chr13',
  'chr14',
  'chr15',
  'chr16',
  'chr17',
  'chr18',
  'chr19',
  'chr20',
  'chr21',
  'chr22',
  'chrX',
  'chrY',
];

describe('AssemblySessionRegistry  Phase 3 — lazy + LRU + cancel)', () => {
  it('opens lazily: constructing opens nothing; ensure opens exactly that chrom', async () => {
    const fake = makeDriver();
    const reg = new AssemblySessionRegistry({
      driver: fake.driver,
      chroms: GRCH38_24.map(chromConfig),
    });
    expect(fake.opened).toEqual([]);
    expect(reg.residentChroms()).toEqual([]);

    const h = await reg.ensure('chr7');
    expect(h?.chrom).toBe('chr7');
    expect(h?.sessionId).toMatch(/^sess-chr7-/);
    expect(fake.opened).toEqual(['chr7']);
    expect(reg.residentChroms()).toEqual(['chr7']);
  });

  it('concurrent ensure() for the same chrom dedupe to ONE open', async () => {
    const fake = makeDriver({ openDelayResolvers: true });
    const reg = new AssemblySessionRegistry({
      driver: fake.driver,
      chroms: GRCH38_24.map(chromConfig),
    });
    const a = reg.ensure('chr3');
    const b = reg.ensure('chr3');
    const c = reg.ensure('chr3');
    fake.flushOpens();
    const [ha, hb, hc] = await Promise.all([a, b, c]);
    expect(fake.opened).toEqual(['chr3']);
    expect(ha?.sessionId).toBe(hb?.sessionId);
    expect(hb?.sessionId).toBe(hc?.sessionId);
  });

  it('BOUNDED-RESIDENCY ORACLE: a genome-length pan never exceeds the LRU cap', async () => {
    const fake = makeDriver();
    const cap = DEFAULT_ASSEMBLY_SESSION_CAP;
    const reg = new AssemblySessionRegistry({
      driver: fake.driver,
      chroms: GRCH38_24.map(chromConfig),
      cap,
    });
    for (const chrom of GRCH38_24) {
      await reg.ensure(chrom);
      expect(reg.residentChroms().length).toBeLessThanOrEqual(cap);
    }
    expect(reg.stats().peakResident).toBeLessThanOrEqual(cap);
    expect(fake.peakLive).toBeLessThanOrEqual(cap + 1);
    expect(fake.opened).toHaveLength(24);
    expect(fake.closed).toHaveLength(24 - cap);
  });

  it('evicts the LEAST-recently-used (re-touching a chrom keeps it resident)', async () => {
    const fake = makeDriver();
    const reg = new AssemblySessionRegistry({
      driver: fake.driver,
      chroms: GRCH38_24.map(chromConfig),
      cap: 2,
    });
    await reg.ensure('chr1');
    await reg.ensure('chr2');
    await reg.ensure('chr1');
    await reg.ensure('chr3');
    expect(reg.residentChroms().sort()).toEqual(['chr1', 'chr3']);
    expect(fake.closed).toContain('sess-chr2-2');
    expect(fake.closed).not.toContain('sess-chr1-1');
  });

  it('eviction cancels the evicted session’s in-flight requests', async () => {
    const fake = makeDriver();
    const reg = new AssemblySessionRegistry({
      driver: fake.driver,
      chroms: GRCH38_24.map(chromConfig),
      cap: 1,
    });
    const h1 = await reg.ensure('chr1');
    reg.registerInflight('chr1', 'seq-window-1');
    reg.registerInflight('chr1', 'ann-tile-1');
    await reg.ensure('chr2');
    expect(reg.residentChroms()).toEqual(['chr2']);
    expect(fake.cancelled.map((c) => c.requestId).sort()).toEqual(['ann-tile-1', 'seq-window-1']);
    expect(fake.cancelled.every((c) => c.sessionId === h1?.sessionId)).toBe(true);
  });

  it('cancelInflightOutside cancels non-visible segments, not seam-visible ones', async () => {
    const fake = makeDriver();
    const reg = new AssemblySessionRegistry({
      driver: fake.driver,
      chroms: GRCH38_24.map(chromConfig),
      cap: 4,
    });
    await reg.ensure('chr1');
    await reg.ensure('chr2');
    await reg.ensure('chr3');
    reg.registerInflight('chr1', 'r1');
    reg.registerInflight('chr2', 'r2');
    reg.registerInflight('chr3', 'r3');
    reg.cancelInflightOutside(new Set(['chr1', 'chr2']));
    expect(fake.cancelled.map((c) => c.requestId)).toEqual(['r3']);
  });

  it('single-chromosome assembly is the degenerate case: open once, never evict', async () => {
    const fake = makeDriver();
    const reg = new AssemblySessionRegistry({
      driver: fake.driver,
      chroms: [chromConfig('chr11')],
    });
    await reg.ensure('chr11');
    await reg.ensure('chr11');
    await reg.ensure('chr11');
    expect(fake.opened).toEqual(['chr11']);
    expect(fake.closed).toEqual([]);
    expect(reg.residentChroms()).toEqual(['chr11']);
  });

  it('ensure() for an unknown chromosome returns null and opens nothing', async () => {
    const fake = makeDriver();
    const reg = new AssemblySessionRegistry({
      driver: fake.driver,
      chroms: [chromConfig('chr11')],
    });
    expect(await reg.ensure('chrZ')).toBeNull();
    expect(fake.opened).toEqual([]);
  });

  it('a failed open reports onError, stays idle, and can be retried', async () => {
    const errors: string[] = [];
    let attempt = 0;
    const driver: AssemblySessionDriver = {
      open: (source) => {
        attempt += 1;
        if (attempt === 1) return Promise.reject(new Error('sidecar busy'));
        return Promise.resolve({
          sessionId: `sess-${source.chrom}`,
          sourcePath: source.sourcePath,
          sourceFingerprint: 'fp',
          chrom: source.chrom as string,
          coordinateReady: true,
          validationState: 'valid' as GenomeSessionShell['validationState'],
          tracks: [],
          openedAt: 0,
        });
      },
      closeSession: () => Promise.resolve(),
      cancel: () => {},
    };
    const reg = new AssemblySessionRegistry({
      driver,
      chroms: [chromConfig('chr5')],
      onError: (chrom, err) => errors.push(`${chrom}:${(err as Error).message}`),
    });
    expect(await reg.ensure('chr5')).toBeNull();
    expect(errors).toEqual(['chr5:sidecar busy']);
    expect((await reg.ensure('chr5'))?.sessionId).toBe('sess-chr5');
  });

  it('uses the ready shell manifest for handles and the session id for close calls', async () => {
    const readyManifest: IndexedGenomeManifest = {
      chrom: 'chr11',
      fastaPath: '/tmp/chr11.fa',
      faiPath: '/tmp/chr11.fa.fai',
      gffPath: '/tmp/chr11.gff3.gz',
      tbiPath: '/tmp/chr11.gff3.gz.tbi',
      length: 135_086_622,
    };
    const closed: string[] = [];
    const driver: AssemblySessionDriver = {
      open: (source) =>
        Promise.resolve({
          sessionId: `sess-${source.chrom}`,
          sourcePath: source.sourcePath,
          sourceFingerprint: 'fp-ready',
          chrom: source.chrom as string,
          coordinateReady: true,
          manifest: readyManifest,
          validationState: 'valid' as GenomeSessionShell['validationState'],
          tracks: [],
          openedAt: 0,
        }),
      closeSession: (sessionId) => {
        closed.push(sessionId);
        return Promise.resolve();
      },
      cancel: () => {},
    };
    const reg = new AssemblySessionRegistry({
      driver,
      chroms: [chromConfig('chr11')],
    });

    const handle = await reg.ensure('chr11');
    expect(handle?.manifest).toEqual(readyManifest);
    reg.dispose();
    expect(closed).toEqual(['sess-chr11']);
  });

  it('dispose closes every resident session and cancels in-flight', async () => {
    const fake = makeDriver();
    const reg = new AssemblySessionRegistry({
      driver: fake.driver,
      chroms: GRCH38_24.map(chromConfig),
      cap: 4,
    });
    await reg.ensure('chr1');
    await reg.ensure('chr2');
    reg.registerInflight('chr1', 'r1');
    reg.dispose();
    expect(fake.closed.sort()).toEqual(['sess-chr1-1', 'sess-chr2-2']);
    expect(fake.cancelled.map((c) => c.requestId)).toEqual(['r1']);
    expect(fake.liveCount).toBe(0);
    expect(await reg.ensure('chr3')).toBeNull();
  });
});
