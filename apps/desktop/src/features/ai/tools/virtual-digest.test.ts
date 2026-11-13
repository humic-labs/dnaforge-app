import { execDesignContract } from '../../../test-utils/design-output-test-helper';
import { virtualDigestOutputSchema } from './design-output-schemas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { execOpts, resetCanvasStore } from './test-helpers';
import { useCanvasStore } from '../../canvas/store';
import { useSequenceStore } from '../../sequence/store';
import { parseBiologyContent } from './parse-biology-file';
import {
  buildDigestSnapshotId,
  createVirtualDigestTool,
  MAX_DIGEST_ENZYMES,
  MAX_DIGEST_SOURCE_BASES,
  virtualDigestSchema,
} from './virtual-digest';

const { mockPlatform, mockResolveSequenceDocumentById } = vi.hoisted(() => ({
  mockPlatform: {
    fs: {
      readTextFile: vi.fn(),
      stat: vi.fn(),
    },
  },
  mockResolveSequenceDocumentById: vi.fn(),
}));

vi.mock('../../../platform', () => ({
  platform: () => mockPlatform,
  initPlatform: vi.fn().mockResolvedValue(mockPlatform),
}));

vi.mock('../../sequence/sequence-document-repository', () => ({
  resolveSequenceDocumentById: mockResolveSequenceDocumentById,
  resolveCanonicalSequenceDocumentById: mockResolveSequenceDocumentById,
}));

const BSA_I = {
  name: 'BsaI',
  recognition_sequence: 'GGTCTC',
  recognition_sequence_length: 6,
  cut_position_top: 7,
  cut_position_bottom: 11,
  overhang_type: '5_prime',
  overhang_length: 4,
  enzyme_type: 'Type IIS',
  prototype: null,
  source_organism: null,
  methylation_site: null,
  methylation_sensitivity: null,
};
const ECO_RI = {
  ...BSA_I,
  name: 'EcoRI',
  recognition_sequence: 'GAATTC',
  cut_position_top: 1,
  cut_position_bottom: 5,
};
const BBS_I = {
  ...BSA_I,
  name: 'BbsI',
  recognition_sequence: 'GAAGAC',
  cut_position_top: 8,
  cut_position_bottom: 12,
};
const BPI_I = { ...BBS_I, name: 'BpiI' };

vi.mock('@waypoint/sequence-utils', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, loadAllEnzymes: vi.fn(async () => [BSA_I, ECO_RI, BBS_I, BPI_I]) };
});

const WORKSPACE = '/home/user/lab';
const folders: WorkspaceFolder[] = [{ name: 'lab', path: WORKSPACE, addedAt: 1 }];

function genBank(name: string, sequence: string, topology = 'circular'): string {
  const chunks: string[] = [];
  for (let i = 0; i < sequence.length; i += 60) {
    chunks.push(`${String(i + 1).padStart(9)} ${sequence.slice(i, i + 60)}`);
  }
  return [
    `LOCUS       ${name.padEnd(16)} ${String(sequence.length).padStart(7)} bp    DNA     ${topology} SYN 01-JAN-2026`,
    'FEATURES             Location/Qualifiers',
    'ORIGIN',
    ...chunks,
    '//',
    '',
  ].join('\n');
}

const FILLER = 'AAAACCCCTTTTGGGGAAAACCCCTTTTGGGG';
const TWO_SITE = FILLER + 'GGTCTCAAAAAAAAAAAA' + FILLER + 'GAGACCTTTTTTTTTTTT' + FILLER;

function setFile(content: string) {
  mockPlatform.fs.stat.mockResolvedValue({ size: content.length } as never);
  mockPlatform.fs.readTextFile.mockResolvedValue(content);
}

type DigestResult = {
  error?: string;
  message?: string;
  digestSnapshotId?: string;
  topology?: string;
  topologyAssumed?: boolean;
  enzymeNames?: string[];
  digestKind?: string;
  cutSiteCount?: number;
  fragmentCount?: number;
  ggStatus?: string;
  diagnostics?: unknown[];
  unknownEnzymes?: string[];
  limit?: number;
  fragments?: Array<{
    fragmentIndex: number;
    fragmentCandidateId: string;
    startPosition: number;
    endPosition: number;
    start1: number;
    end1: number;
    ggType: string;
    hasInternalSites: boolean;
    internalSites: unknown[];
    upstream: { overhang: string; siteOrientation: string; rdEnd: Record<string, unknown> | null };
    downstream: { rdEnd: Record<string, unknown> | null };
  }>;
};

describe('virtual_digest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveSequenceDocumentById.mockImplementation(async (documentId: string) => {
      const sourceNameByDocumentId: Record<string, string> = {
        'p-test': 'plasmids/pTest.gb',
        'p-alias': 'plasmids/pAlias.gb',
        'p-huge': 'plasmids/pHuge.gb',
        'many-cuts': 'plasmids/many-cuts.gb',
        'linear-part': 'parts/linear.fa',
        'unknown-topology': 'parts/unknown-topology.gb',
        'topology-less': 'parts/topology-less.gff3',
        gblock: 'parts/gblock.gb',
        missing: 'plasmids/missing.gb',
        'open-only': '/home/user/open-only.gb',
      };
      const sourceName = sourceNameByDocumentId[documentId] ?? `${documentId}.gb`;
      return {
        documentId,
        sourcePath: sourceName.startsWith('/') ? sourceName : `${WORKSPACE}/${sourceName}`,
        ref: { kind: 'catalog-sequence', entityId: documentId },
      };
    });
    resetCanvasStore();
    useSequenceStore.setState({ sequences: {} });
  });
  afterEach(() => {
    resetCanvasStore();
    useSequenceStore.setState({ sequences: {} });
  });

  async function digest(args: Record<string, unknown>) {
    return execDesignContract<DigestResult>(
      virtualDigestOutputSchema,
      createVirtualDigestTool(folders),
      args
    );
  }

  it('returns fragments with cut-side-oriented ends, never a flat overhang string', async () => {
    setFile(genBank('pTest', TWO_SITE));
    const result = await digest({ documentId: 'p-test', enzymes: ['BsaI'] });

    expect(result.error).toBeUndefined();
    expect(result.cutSiteCount).toBe(2);
    expect(result.fragments).toHaveLength(2);

    const fragment = result.fragments![0];
    expect(fragment.upstream.rdEnd).not.toBeNull();
    expect(fragment.upstream.rdEnd).toHaveProperty('overhangType');
    expect(fragment.upstream.rdEnd).toHaveProperty('cutPositionTop');
    expect(fragment.upstream.rdEnd).toHaveProperty('strand');
    expect(['forward', 'reverse']).toContain(fragment.upstream.siteOrientation);
  });

  it('digests an already-open absolute file when no workspace is mounted', async () => {
    const outside = '/home/user/open-only.gb';
    const parsed = parseBiologyContent(genBank('openOnly', TWO_SITE), outside);
    useSequenceStore.setState({ sequences: { 'open-only': parsed.sequence } });
    useCanvasStore.getState().openTab('main', {
      type: 'sequence',
      entityId: 'open-only',
      sequenceDocument: { kind: 'catalog-sequence', entityId: 'open-only' },
      label: 'open-only.gb',
    });

    const result = await execDesignContract<DigestResult>(
      virtualDigestOutputSchema,
      createVirtualDigestTool([]),
      {
        documentId: 'open-only',
        enzymes: ['BsaI'],
      }
    );

    expect(result.error).toBeUndefined();
    expect(result.cutSiteCount).toBe(2);
    expect(result.fragmentCount).toBe(2);
    expect(mockPlatform.fs.readTextFile).not.toHaveBeenCalled();
  });

  it('emits BOTH coordinate conventions so the agent cannot pick the wrong one', async () => {
    setFile(genBank('pTest', TWO_SITE));
    const result = await digest({ documentId: 'p-test', enzymes: ['BsaI'] });

    expect(result.fragments!.length).toBeGreaterThan(0);
    for (const fragment of result.fragments!) {
      expect(fragment.start1).toBe(fragment.startPosition + 1);
      expect(fragment.end1).toBe(fragment.endPosition);
    }
  });

  it('surfaces the engine verdicts rather than making the agent re-derive them', async () => {
    setFile(genBank('pTest', TWO_SITE));
    const result = await digest({ documentId: 'p-test', enzymes: ['BsaI'] });
    expect(result.ggStatus).toBeDefined();
    expect(Array.isArray(result.diagnostics)).toBe(true);
  });

  it('classifies ggType only for a single Type IIS enzyme', async () => {
    setFile(genBank('pTest', TWO_SITE));
    const single = await digest({ documentId: 'p-test', enzymes: ['BsaI'] });
    expect(single.fragments!.length).toBeGreaterThan(0);
    expect(single.fragments!.every((f) => f.ggType !== 'rd')).toBe(true);

    const double = await digest({ documentId: 'p-test', enzymes: ['BsaI', 'EcoRI'] });
    expect(double.fragments!.length).toBeGreaterThan(0);
    expect(double.fragments!.every((f) => f.ggType === 'rd')).toBe(true);
  });

  it('canonicalizes duplicate enzyme names before classifying the digest', async () => {
    setFile(genBank('pTest', TWO_SITE));
    const result = await digest({ documentId: 'p-test', enzymes: ['BsaI', 'bsai'] });

    expect(result.error).toBeUndefined();
    expect(result.enzymeNames).toEqual(['BsaI']);
    expect(result.digestKind).toBe('goldengate');
    expect(result.fragments!.every((fragment) => fragment.ggType !== 'rd')).toBe(true);
  });

  it('canonicalizes isoschizomer aliases before deduplicating the digest', async () => {
    const twoBbsSites = FILLER + 'GAAGACAAAAAAAAAAAA' + FILLER + 'GTCTTCTTTTTTTTTTTT' + FILLER;
    setFile(genBank('pAlias', twoBbsSites));

    const result = await digest({
      documentId: 'p-alias',
      enzymes: ['BbsI', 'BpiI'],
    });

    expect(result.error).toBeUndefined();
    expect(result.enzymeNames).toEqual(['BbsI']);
    expect(result.digestKind).toBe('goldengate');
    expect(result.fragments!.every((fragment) => fragment.ggType !== 'rd')).toBe(true);
  });

  it('bounds the enzyme list at the schema boundary', () => {
    const parsed = virtualDigestSchema.safeParse({
      documentId: 'p-test',
      enzymes: Array.from({ length: MAX_DIGEST_ENZYMES + 1 }, (_, index) => `E${index}`),
    });

    expect(parsed.success).toBe(false);
  });

  it('honors a canceled MCP call before reading or scanning the source', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      execDesignContract(
        virtualDigestOutputSchema,
        createVirtualDigestTool(folders),
        { documentId: 'p-test', enzymes: ['BsaI'] },
        { ...execOpts, abortSignal: controller.signal }
      )
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(mockPlatform.fs.readTextFile).not.toHaveBeenCalled();
  });

  it('gives every fragment a content-addressed id that is stable across identical calls', async () => {
    setFile(genBank('pTest', TWO_SITE));
    const first = await digest({ documentId: 'p-test', enzymes: ['BsaI'] });
    const second = await digest({ documentId: 'p-test', enzymes: ['BsaI'] });

    expect(first.digestSnapshotId).toBe(second.digestSnapshotId);
    expect(first.fragments![0].fragmentCandidateId).toBe(second.fragments![0].fragmentCandidateId);
    expect(first.fragments![0].fragmentCandidateId).toContain(first.digestSnapshotId!);
  });

  it('changes the snapshot id when the source bases change', async () => {
    const base = { sourceDocumentId: 'source-a', annotations: [] };
    const a = buildDigestSnapshotId({
      ...base,
      sequence: 'AAAA',
      circular: true,
      enzymeNames: ['BsaI'],
    });
    const b = buildDigestSnapshotId({
      ...base,
      sequence: 'AAAT',
      circular: true,
      enzymeNames: ['BsaI'],
    });
    const c = buildDigestSnapshotId({
      ...base,
      sequence: 'AAAA',
      circular: false,
      enzymeNames: ['BsaI'],
    });
    const d = buildDigestSnapshotId({
      ...base,
      sequence: 'AAAA',
      circular: true,
      enzymeNames: ['EcoRI'],
    });
    expect(new Set([a, b, c, d]).size).toBe(4);
  });

  it('is order-insensitive in the enzyme set', async () => {
    const base = {
      sequence: 'AAAA',
      circular: true,
      sourceDocumentId: 'source-a',
      annotations: [],
    };
    const identity = buildDigestSnapshotId({ ...base, enzymeNames: ['BsaI', 'EcoRI'] });
    expect(identity).toMatch(/^v\d+-[a-z0-9]+-4-circ-[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/);
    expect(identity).toBe(
      buildDigestSnapshotId({ ...base, enzymeNames: ['EcoRI', 'BsaI'] })
    );
  });

  it('binds snapshot identity to source provenance and annotations, not bases alone', () => {
    const base = {
      sequence: 'AAAA',
      circular: true,
      enzymeNames: ['BsaI'],
      sourceDocumentId: 'source-a',
      annotations: [{ name: 'feature-a', start: 1, end: 4 }],
    };
    const original = buildDigestSnapshotId(base);
    const otherDocument = buildDigestSnapshotId({ ...base, sourceDocumentId: 'source-b' });
    const otherAnnotations = buildDigestSnapshotId({
      ...base,
      annotations: [{ name: 'feature-b', start: 1, end: 4 }],
    });

    expect(otherDocument).not.toBe(original);
    expect(otherAnnotations).not.toBe(original);
  });

  it('reports an unknown enzyme with the catalog, not a bare failure', async () => {
    setFile(genBank('pTest', TWO_SITE));
    const result = await digest({ documentId: 'p-test', enzymes: ['NotAnEnzyme'] });
    expect(result.error).toBe('UNKNOWN_ENZYME');
    expect(result.unknownEnzymes).toEqual(['NotAnEnzyme']);
  });

  it('refuses a source too large to embed in a persisted design', async () => {
    const huge = 'A'.repeat(MAX_DIGEST_SOURCE_BASES + 1);
    setFile(genBank('pHuge', huge));
    const result = await digest({ documentId: 'p-huge', enzymes: ['BsaI'] });
    expect(result.error).toBe('SOURCE_TOO_LARGE_FOR_DESIGN');
    expect(result.limit).toBe(MAX_DIGEST_SOURCE_BASES);
  });

  it('refuses a high-cut digest with a structured fragment limit error', async () => {
    setFile(genBank('manyCuts', 'GGTCTC'.repeat(501)));
    const result = await digest({ documentId: 'many-cuts', enzymes: ['BsaI'] });

    expect(result.error).toBe('TOO_MANY_FRAGMENTS');
    expect(result.fragmentCount).toBeGreaterThan(500);
    expect(result.limit).toBe(500);
  });

  it('reports the topology it actually used', async () => {
    setFile(genBank('pTest', TWO_SITE, 'circular'));
    const circular = await digest({ documentId: 'p-test', enzymes: ['BsaI'] });
    expect(circular.topology).toBe('circular');
  });

  it('defaults FASTA to linear and reports that topology was assumed', async () => {
    setFile(`>linear-part\n${TWO_SITE}\n`);
    const result = await digest({ documentId: 'linear-part', enzymes: ['BsaI'] });

    expect(result.topology).toBe('linear');
    expect(result.topologyAssumed).toBe(true);
    expect(result.fragmentCount).toBe(3);
  });

  it('reports omitted GenBank topology as an assumed linear fallback', async () => {
    setFile(
      genBank('unknownTopology', TWO_SITE, '').replace(/\s+SYN 01-JAN-2026/, ' SYN 01-JAN-2026')
    );
    const result = await digest({
      documentId: 'unknown-topology',
      enzymes: ['BsaI'],
    });

    expect(result.topology).toBe('linear');
    expect(result.topologyAssumed).toBe(true);
    expect(result.fragmentCount).toBe(3);
  });

  it('reports topology-less GFF3 as an assumed linear fallback', async () => {
    setFile(
      [
        '##gff-version 3',
        `part\ttest\tgene\t1\t${TWO_SITE.length}\t.\t+\t.\tID=part`,
        '##FASTA',
        '>part',
        TWO_SITE,
      ].join('\n')
    );
    const result = await digest({ documentId: 'topology-less', enzymes: ['BsaI'] });

    expect(result.topology).toBe('linear');
    expect(result.topologyAssumed).toBe(true);
    expect(result.fragmentCount).toBe(3);
  });

  it('🟥 actually DIGESTS a linear source linearly, not just labels it linear', async () => {
    setFile(genBank('pTest', TWO_SITE, 'circular'));
    const circular = await digest({ documentId: 'p-test', enzymes: ['BsaI'] });

    setFile(genBank('gblock', TWO_SITE, 'linear'));
    const linear = await digest({ documentId: 'gblock', enzymes: ['BsaI'] });

    expect(linear.topology).toBe('linear');
    expect(linear.cutSiteCount).toBe(circular.cutSiteCount);
    expect(linear.fragmentCount).toBe((circular.fragmentCount as number) + 1);

    const fragments = linear.fragments as Array<Record<string, unknown>>;
    expect(fragments[0].ggType).toBe('unusable');
    expect(fragments[fragments.length - 1].ggType).toBe('unusable');
  });

  it('returns a structured error instead of throwing when the file cannot be read', async () => {
    mockPlatform.fs.stat.mockRejectedValue(new Error('ENOENT: no such file'));
    mockPlatform.fs.readTextFile.mockRejectedValue(new Error('ENOENT: no such file'));
    const result = await digest({ documentId: 'missing', enzymes: ['BsaI'] });
    expect(result.error).toBeDefined();
    expect(result.message).toBeDefined();
  });
});
