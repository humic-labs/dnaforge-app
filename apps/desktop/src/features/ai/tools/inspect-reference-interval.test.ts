import { assertMcpOutput } from '../../../test-utils/mcp-output-test-helper';
import { inspectReferenceIntervalOutputSchema } from './genome-output-schemas';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InMemoryGenomeDataSource,
  isReferenceIntervalFailure,
  type GenomeDataSource,
} from '@waypoint/genome-data';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import {
  INDEXED_GENOME_INVALID_SEQUENCE_ERROR_CODE,
  INDEXED_GENOME_SOURCE_UNAVAILABLE_ERROR_CODE,
} from '../../../shared/indexed-genome';
import { execTool as executeTool } from './test-helpers';
import {
  createInspectReferenceIntervalTool,
  inspectReferenceIntervalSchema,
  resolveIndexedReferenceSource,
  type InspectReferenceIntervalInput,
} from './inspect-reference-interval';

const { mockPlatform } = vi.hoisted(() => ({
  mockPlatform: {
    fs: {
      exists: vi.fn(),
      resolveInlineReferenceTarget: vi.fn(),
    },
    genome: {
      init: vi.fn(),
      getSequence: vi.fn(),
      getFeatures: vi.fn(),
      getFeatureDetailsByManifest: vi.fn(),
      searchSequence: vi.fn(),
    },
  },
}));

vi.mock('../../../platform', () => ({
  platform: () => mockPlatform,
  initPlatform: vi.fn().mockResolvedValue(mockPlatform),
}));

const WORKSPACE = '/home/user/lab';
const singleFolder: WorkspaceFolder[] = [{ name: 'lab', path: WORKSPACE, addedAt: 1 }];

function input(
  partial: Partial<InspectReferenceIntervalInput> = {}
): InspectReferenceIntervalInput {
  return {
    sourcePath: 'genomes/tiny.fa',
    chrom: 'chrI',
    start0: 0,
    end0: 9,
    strand: '+',
    operation: 'read',
    ...partial,
  };
}

function memorySource(sequence = 'ATGAAATGA'): GenomeDataSource {
  return new InMemoryGenomeDataSource({
    chrom: 'chrI',
    sequence,
    features: [],
  });
}

async function collectHits(source: GenomeDataSource): Promise<void> {
  for await (const _hit of source.searchSequence('chrI', 'ATG', { start: 0, end: 9 })) { continue; }
}

describe('inspect_reference_interval schema', () => {
  it('keeps every callable field as a top-level property and rejects unknown keys', () => {
    expect(inspectReferenceIntervalSchema.safeParse(input()).success).toBe(true);
    expect(inspectReferenceIntervalSchema.safeParse({ ...input(), unexpected: true }).success).toBe(
      false
    );
  });
});

describe('inspect_reference_interval tool', () => {
  it('reads exact bases through the shared kernel from an explicit source', async () => {
    const tool = createInspectReferenceIntervalTool(singleFolder, {
      resolveSource: async () => ({
        ok: true,
        source: memorySource(),
        identity: { sourceId: 'genomes/tiny.fa', fastaPath: 'genomes/tiny.fa' },
      }),
    });
    const result = await execTool<{ ok: boolean; sequence?: string }>(tool, input());
    expect(result.ok).toBe(true);
    expect(result.sequence).toBe('ATGAAATGA');
  });

  it('extracts a derived sequence payload without writing a file', async () => {
    const tool = createInspectReferenceIntervalTool(singleFolder, {
      resolveSource: async () => ({
        ok: true,
        source: memorySource(),
        identity: { sourceId: 'genomes/tiny.fa' },
      }),
    });
    const result = await execTool<{
      ok: boolean;
      derived?: { sequence: string; topology: string };
    }>(tool, input({ operation: 'extract', start0: 0, end0: 6 }));
    expect(result.ok).toBe(true);
    expect(result.derived?.sequence).toBe('ATGAAA');
    expect(result.derived?.topology).toBe('linear');
  });

  it('translates six frames without the caller supplying raw bases', async () => {
    const tool = createInspectReferenceIntervalTool(singleFolder, {
      resolveSource: async () => ({
        ok: true,
        source: memorySource(),
        identity: { sourceId: 'genomes/tiny.fa' },
      }),
    });
    const result = await execTool<{
      ok: boolean;
      translations?: Array<{ strand: string; frame: number; protein: string }>;
    }>(tool, input({ operation: 'translate' }));
    expect(result.ok).toBe(true);
    expect(result.translations).toHaveLength(6);
    expect(result.translations?.find((row) => row.strand === '+' && row.frame === 0)?.protein).toBe(
      'MK*'
    );
  });

  it('returns CANCELLED when the tool abort signal is already fired', async () => {
    const controller = new AbortController();
    controller.abort();
    const tool = createInspectReferenceIntervalTool(singleFolder, {
      resolveSource: async () => ({
        ok: true,
        source: memorySource(),
        identity: { sourceId: 'genomes/tiny.fa' },
      }),
    });
    const result = await execTool<{ ok: boolean; code?: string }>(tool, input(), {
      toolCallId: 'test',
      messages: [],
      abortSignal: controller.signal,
      grantedCapabilities: undefined,
    });
    expect(result).toMatchObject({ ok: false, code: 'CANCELLED' });
  });

  it('returns MISSING_SOURCE when no user workspace is mounted', async () => {
    const result = await resolveIndexedReferenceSource(input(), []);
    expect(isReferenceIntervalFailure(result)).toBe(true);
    if (!isReferenceIntervalFailure(result)) return;
    expect(result.code).toBe('MISSING_SOURCE');
    expect(result.error).toMatch(/No project is open/);
  });
});

describe('resolveIndexedReferenceSource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPlatform.fs.resolveInlineReferenceTarget.mockImplementation(
      async (request: {
        roots: Array<{ name: string; path: string }>;
        root: string;
        segments: string[];
      }) => {
        const root = request.roots.find((entry) => entry.name === request.root);
        if (!root) return { ok: false, code: 'root-not-found' };
        const relativePath = request.segments.join('/');
        const path = `${root.path}/${relativePath}`;
        return {
          ok: true,
          path,
          rootPath: root.path,
          canonicalPath: path,
          canonicalRootPath: root.path,
          relativePath,
          targetType: 'file',
        };
      }
    );
  });

  it('refuses a path that escapes the workspace', async () => {
    const result = await resolveIndexedReferenceSource(
      input({ sourcePath: '/etc/passwd' }),
      singleFolder
    );
    expect(isReferenceIntervalFailure(result)).toBe(true);
    if (!isReferenceIntervalFailure(result)) return;
    expect(result.code).toBe('MISSING_SOURCE');
    expect(result.error).toMatch(/outside every open project/);
  });

  it('refuses a normalized absolute traversal outside the workspace', async () => {
    const result = await resolveIndexedReferenceSource(
      input({ sourcePath: `${WORKSPACE}/../outside/reference.fa` }),
      singleFolder
    );
    expect(isReferenceIntervalFailure(result)).toBe(true);
    if (!isReferenceIntervalFailure(result)) return;
    expect(result.code).toBe('MISSING_SOURCE');
    expect(result.error).toMatch(/outside every open project/);
  });

  it('refuses an indexed FASTA that has no companion .fai', async () => {
    mockPlatform.fs.resolveInlineReferenceTarget.mockImplementation(async (request) =>
      request.segments.at(-1)?.endsWith('.fai')
        ? { ok: false, code: 'target-not-found' }
        : {
            ok: true,
            path: `${WORKSPACE}/${request.segments.join('/')}`,
            rootPath: WORKSPACE,
            canonicalPath: `${WORKSPACE}/${request.segments.join('/')}`,
            canonicalRootPath: WORKSPACE,
            relativePath: request.segments.join('/'),
            targetType: 'file',
          }
    );
    const result = await resolveIndexedReferenceSource(input(), singleFolder);
    expect(isReferenceIntervalFailure(result)).toBe(true);
    if (!isReferenceIntervalFailure(result)) return;
    expect(result.code).toBe('MISSING_SOURCE');
    expect(result.error).toMatch(/\.fai|index/i);
  });

  it('resolves a workspace FASTA + .fai into a genome data source', async () => {
    mockPlatform.genome.init.mockResolvedValue({ length: 9 });
    mockPlatform.genome.getSequence.mockResolvedValue('ATGAAATGA');
    const resolved = await resolveIndexedReferenceSource(input(), singleFolder);
    expect(resolved.ok).toBe(true);
    if (resolved.ok !== true) return;
    expect(resolved.identity.sourceId).toBe('genomes/tiny.fa');
    expect(await resolved.source.getSequence('chrI', 0, 9)).toBe('ATGAAATGA');
    expect(mockPlatform.genome.getSequence).toHaveBeenCalledWith(
      expect.objectContaining({
        chrom: 'chrI',
        fastaPath: `${WORKSPACE}/genomes/tiny.fa`,
        faiPath: `${WORKSPACE}/genomes/tiny.fa.fai`,
        workspaceRootPaths: [WORKSPACE],
      }),
      'chrI',
      0,
      9
    );
  });

  it('admits the BGZF FASTA extension produced by native reference preparation', async () => {
    const resolved = await resolveIndexedReferenceSource(
      input({ sourcePath: 'genomes/tiny.fa.gz' }),
      singleFolder
    );

    expect(resolved.ok).toBe(true);
    if (resolved.ok !== true) return;
    expect(resolved.identity).toMatchObject({
      sourceId: 'genomes/tiny.fa.gz',
      fastaPath: 'genomes/tiny.fa.gz',
    });
    expect(mockPlatform.fs.resolveInlineReferenceTarget).toHaveBeenCalledWith(
      expect.objectContaining({ segments: ['genomes', 'tiny.fa.gz.fai'] })
    );
  });

  it('maps a source lost after renderer admission to MISSING_SOURCE', async () => {
    mockPlatform.genome.init.mockRejectedValue(
      new Error(`${INDEXED_GENOME_SOURCE_UNAVAILABLE_ERROR_CODE}: fastaPath disappeared.`)
    );
    const tool = createInspectReferenceIntervalTool(singleFolder);

    const result = await execTool<{ ok: boolean; code?: string; error?: string }>(tool, input());

    expect(result).toMatchObject({
      ok: false,
      code: 'MISSING_SOURCE',
      error: expect.stringMatching(/no longer available/i),
    });
  });

  it('maps the stable Electron IPC sequence marker to INVALID_SOURCE', async () => {
    mockPlatform.genome.init.mockResolvedValue({ length: 9 });
    mockPlatform.genome.searchSequence.mockRejectedValue(
      new Error(
        `Error invoking remote method 'genome:searchSequence': ${INDEXED_GENOME_INVALID_SEQUENCE_ERROR_CODE}: indexed FASTA sequence validation failed.`
      )
    );
    const tool = createInspectReferenceIntervalTool(singleFolder);

    const result = await execTool<{ ok: boolean; code?: string; error?: string }>(
      tool,
      input({ operation: 'search', motif: 'ATG' })
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'INVALID_SOURCE',
      error: expect.stringMatching(/IUPAC nucleotide alphabet/i),
    });
  });

  it('loads complete feature closure through the manifest-backed adapter', async () => {
    mockPlatform.genome.getFeatureDetailsByManifest.mockResolvedValue({
      chrom: 'chrI',
      featureId: 'rna1',
      feature: null,
      relatedFeatures: [],
      sourceRecordCount: 0,
      window: { start: 0, end: 9 },
      truncated: false,
    });
    const resolved = await resolveIndexedReferenceSource(
      input({
        operation: 'translate_spliced',
        gffPath: 'genomes/tiny.gff3.gz',
      }),
      singleFolder
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok !== true) return;

    const details = await resolved.source.getFeatureDetails?.({
      chrom: 'chrI',
      start: 0,
      end: 9,
      featureId: 'rna1',
      maxWindowBp: 2_000_000,
    });

    expect(details?.truncated).toBe(false);
    expect(mockPlatform.genome.getFeatureDetailsByManifest).toHaveBeenCalledWith(
      expect.objectContaining({
        fastaPath: `${WORKSPACE}/genomes/tiny.fa`,
        faiPath: `${WORKSPACE}/genomes/tiny.fa.fai`,
        gffPath: `${WORKSPACE}/genomes/tiny.gff3.gz`,
        tbiPath: `${WORKSPACE}/genomes/tiny.gff3.gz.tbi`,
      }),
      expect.objectContaining({ featureId: 'rna1', maxWindowBp: 2_000_000 })
    );
  });

  it('fails early when spliced translation has no annotation source', async () => {
    const resolved = await resolveIndexedReferenceSource(
      input({ operation: 'translate_spliced' }),
      singleFolder
    );
    expect(resolved).toMatchObject({
      ok: false,
      code: 'MISSING_SOURCE',
      error: expect.stringMatching(/gffPath is required/),
    });
  });

  it.each(['genomes/tiny.gff', 'genomes/tiny.gff3'])(
    'rejects uncompressed Tabix annotation input %s',
    async (gffPath) => {
      const resolved = await resolveIndexedReferenceSource(
        input({ operation: 'translate_spliced', gffPath }),
        singleFolder
      );

      expect(resolved).toMatchObject({
        ok: false,
        code: 'MISSING_SOURCE',
        error: expect.stringMatching(/unsupported file extension/),
      });
    }
  );

  it('uses the canonical admitted path and rejects a symlink escape result', async () => {
    mockPlatform.fs.resolveInlineReferenceTarget.mockResolvedValue({
      ok: false,
      code: 'outside-root',
    });

    const resolved = await resolveIndexedReferenceSource(input(), singleFolder);

    expect(resolved).toMatchObject({
      ok: false,
      code: 'MISSING_SOURCE',
      error: expect.stringMatching(/outside-root/),
    });
  });

  it('gives concurrent motif searches distinct lifecycle client identities', async () => {
    mockPlatform.genome.searchSequence.mockResolvedValue([]);
    const resolved = await resolveIndexedReferenceSource(input(), singleFolder);
    expect(resolved.ok).toBe(true);
    if (resolved.ok !== true) return;

    await Promise.all([collectHits(resolved.source), collectHits(resolved.source)]);

    const firstControl = mockPlatform.genome.searchSequence.mock.calls[0]?.[4];
    const secondControl = mockPlatform.genome.searchSequence.mock.calls[1]?.[4];
    expect(firstControl?.requestId).not.toBe(secondControl?.requestId);
    expect(firstControl?.clientId).not.toBe(secondControl?.clientId);
  });

  it('forwards the abort signal into the platform search lifecycle', async () => {
    mockPlatform.genome.searchSequence.mockResolvedValue([]);
    const resolved = await resolveIndexedReferenceSource(input(), singleFolder);
    expect(resolved.ok).toBe(true);
    if (resolved.ok !== true) return;
    const controller = new AbortController();

    await collectHitsWithSignal(resolved.source, controller.signal);

    expect(mockPlatform.genome.searchSequence.mock.calls[0]?.[4]?.signal).toBe(controller.signal);
  });
});

async function collectHitsWithSignal(source: GenomeDataSource, signal: AbortSignal): Promise<void> {
  for await (const _hit of source.searchSequence('chrI', 'ATG', {
    start: 0,
    end: 9,
    signal,
  })) { continue; }
}

async function execTool<T>(...args: Parameters<typeof executeTool>): Promise<T> {
  const result = await executeTool<T>(...args);
  if (result && typeof result === 'object' && 'ok' in result && result.ok === true)
    assertMcpOutput(inspectReferenceIntervalOutputSchema, result);
  return result;
}
