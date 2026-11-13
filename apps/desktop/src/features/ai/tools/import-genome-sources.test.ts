import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { useCanvasStore } from '../../canvas/public/store';
import type { GenomeSourceImportOutcome } from '../../sequence/public/import-genome-sources';
import { useLaneContractStore } from '../../sequence/public/lane-contract-store';
import {
  createImportGenomeSourcesTool,
  genomeSourceLocators,
  importGenomeSourcesSchema,
  isRemoteGenomeSourceLocator,
  type ImportGenomeSourcesSuccess,
} from './import-genome-sources';

const FOLDERS: WorkspaceFolder[] = [{ path: '/lab/project', name: 'project', addedAt: 1 }];
const ASSEMBLY_ID = 'saccer3-lab';

function openIndexedTab(): string {
  return useCanvasStore.getState().openTab('main', {
    type: 'sequence',
    entityId: 'assembly:lab',
    label: 'Lab yeast',
    sequenceDocument: { kind: 'indexed-sequence', documentId: 'assembly:lab' },
    indexedGenome: {
      sourcePath: '/lab/reference/saccer3.fa',
      sourceExt: 'fa',
      chrom: 'chrIV',
      scope: { kind: 'all' },
      assembly: {
        assemblyId: ASSEMBLY_ID,
        displayName: 'Lab yeast',
        chromosomes: [
          {
            chrom: 'chrIV',
            length: 1_531_933,
            manifest: {
              chrom: 'chrIV',
              fastaPath: '/lab/reference/saccer3.fa',
              faiPath: '/lab/reference/saccer3.fa.fai',
            },
          },
        ],
      },
    },
  });
}

function execute(
  tool: ReturnType<typeof createImportGenomeSourcesTool>,
  input: unknown,
  signal?: AbortSignal
) {
  const run = tool.execute;
  if (!run) throw new Error('tool has no execute');
  return run(importGenomeSourcesSchema.parse(input), {
    toolCallId: 'call-1',
    messages: [],
    ...(signal ? { abortSignal: signal } : {}),
  });
}

beforeEach(() => {
  useLaneContractStore.setState({ lanesByOwnerId: {} });
  for (const [panelId, panel] of Object.entries(useCanvasStore.getState().panels)) {
    for (const tab of [...panel.tabs]) useCanvasStore.getState().closeTab(panelId, tab.id);
  }
});

describe('import_genome_sources schema', () => {
  it('accepts every locator kind and refuses unknown keys', () => {
    expect(
      importGenomeSourcesSchema.safeParse({
        sources: [
          { source: { kind: 'local-file', path: 'reads/sample.bam' } },
          {
            source: { kind: 'http', url: 'https://data.example.org/calls.vcf.gz' },
            index: { kind: 'http', url: 'https://data.example.org/calls.vcf.gz.tbi' },
            formatId: 'vcf',
          },
          {
            source: { kind: 's3', bucket: 'b', key: 'k.cram', requesterPays: true, authRef: 'c' },
            index: { kind: 's3', bucket: 'b', key: 'k.cram.crai', authRef: 'c' },
            reference: { kind: 'local-file', path: '/lab/project/ref.fa' },
          },
          { source: { kind: 'gcs', bucket: 'b', object: 'o.bw', billingProject: 'p' } },
          {
            source: {
              kind: 'htsget',
              endpoint: 'https://h.example.org',
              resourceId: 'r',
              dataClass: 'reads',
            },
          },
          {
            source: {
              kind: 'ucsc-track',
              sourceKind: 'ucsc-hub',
              genome: 'sacCer3',
              track: 'genes',
              hubUrl: 'https://hub.example.org/hub.txt',
            },
          },
        ],
      }).success
    ).toBe(true);
    expect(
      importGenomeSourcesSchema.safeParse({
        sources: [{ source: { kind: 'http', url: 'https://x', token: 'secret' } }],
      }).success
    ).toBe(false);
    expect(importGenomeSourcesSchema.safeParse({ sources: [] }).success).toBe(false);
  });

  it('classifies locators for authorization', () => {
    const locators = genomeSourceLocators({
      source: { kind: 'local-file', path: 'a.bam' },
      index: { kind: 'http', url: 'https://x/a.bai' },
    });
    expect(locators.map((locator) => isRemoteGenomeSourceLocator(locator))).toEqual([false, true]);
  });
});

describe('import_genome_sources tool', () => {
  it('refuses without an indexed view and without a project for local files', async () => {
    const run = vi.fn(async () => []);
    const tool = createImportGenomeSourcesTool(FOLDERS, { run });
    await expect(
      execute(tool, { sources: [{ source: { kind: 'http', url: 'https://x/a.bw' } }] })
    ).resolves.toMatchObject({ ok: false, code: 'NO_INDEXED_VIEW', stateChanged: false });

    openIndexedTab();
    const noProject = createImportGenomeSourcesTool([], { run });
    await expect(
      execute(noProject, { sources: [{ source: { kind: 'local-file', path: 'a.bam' } }] })
    ).resolves.toMatchObject({ ok: false, code: 'NO_WORKSPACE' });
    expect(run).not.toHaveBeenCalled();
  });

  it('grounds local paths in the open project and reports each outcome', async () => {
    const tabId = openIndexedTab();
    const run = vi.fn(
      async (input: {
        requests: ReadonlyArray<{ label?: string }>;
      }): Promise<GenomeSourceImportOutcome[]> =>
        input.requests.map((request, index) =>
          index === 0
            ? {
                request: request as GenomeSourceImportOutcome['request'],
                label: 'reads.cram',
                family: 'reads',
                status: 'added',
                trackId: 'pileup-1',
              }
            : {
                request: request as GenomeSourceImportOutcome['request'],
                label: 'signal.bw',
                family: 'data',
                status: 'failed',
                code: 'ADMISSION_FAILED',
                message: 'Chromosome names do not match.',
              }
        )
    );
    const tool = createImportGenomeSourcesTool(FOLDERS, { run });

    const result = (await execute(tool, {
      sources: [
        {
          source: { kind: 'local-file', path: 'reads/sample.cram' },
          reference: { kind: 'local-file', path: '/lab/project/ref/saccer3.fa' },
        },
        { source: { kind: 'http', url: 'https://data.example.org/signal.bw' }, formatId: 'bigwig' },
      ],
    })) as ImportGenomeSourcesSuccess;

    expect(run).toHaveBeenCalledTimes(1);
    const call = run.mock.calls[0]?.[0] as {
      laneOwnerId: string;
      assemblyId: string;
      assemblyDisplayName: string;
      requests: ReadonlyArray<Record<string, unknown>>;
    };
    expect(call).toMatchObject({
      laneOwnerId: tabId,
      assemblyId: ASSEMBLY_ID,
      assemblyDisplayName: 'Lab yeast',
    });
    expect(call.requests).toEqual([
      expect.objectContaining({
        source: { kind: 'local-file', path: '/lab/project/reads/sample.cram' },
        reference: { kind: 'local-file', path: '/lab/project/ref/saccer3.fa' },
        ingress: { kind: 'automation' },
        assemblyId: ASSEMBLY_ID,
      }),
      expect.objectContaining({
        source: { kind: 'http', url: 'https://data.example.org/signal.bw' },
        formatId: 'bigwig',
        ingress: { kind: 'automation' },
      }),
    ]);
    expect(result).toMatchObject({
      ok: true,
      tabId,
      assemblyId: ASSEMBLY_ID,
      added: 1,
      duplicates: 0,
      failed: 1,
      outcomes: [
        { index: 0, status: 'added', family: 'reads', trackId: 'pileup-1' },
        {
          index: 1,
          status: 'failed',
          family: 'data',
          code: 'ADMISSION_FAILED',
          message: 'Chromosome names do not match.',
        },
      ],
    });
  });

  it('refuses a local path outside every open project before touching anything', async () => {
    openIndexedTab();
    const run = vi.fn(async () => []);
    const tool = createImportGenomeSourcesTool(FOLDERS, { run });
    await expect(
      execute(tool, { sources: [{ source: { kind: 'local-file', path: '/elsewhere/a.bam' } }] })
    ).resolves.toMatchObject({
      ok: false,
      code: 'INVALID_SOURCE',
      error: expect.stringContaining('outside every open project'),
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('fails as a whole when nothing was added and reports partial adds on cancellation', async () => {
    openIndexedTab();
    const failed = vi.fn(async (input: { requests: ReadonlyArray<unknown> }) =>
      input.requests.map((request) => ({
        request: request as GenomeSourceImportOutcome['request'],
        label: 'a.bw',
        family: 'data' as const,
        status: 'failed' as const,
        code: 'ADMISSION_FAILED' as const,
        message: 'unreadable',
      }))
    );
    await expect(
      execute(createImportGenomeSourcesTool(FOLDERS, { run: failed }), {
        sources: [{ source: { kind: 'http', url: 'https://x/a.bw' } }],
      })
    ).resolves.toMatchObject({ ok: false, code: 'NO_SOURCES_ADDED', error: 'a.bw: unreadable' });

    const controller = new AbortController();
    const partial = vi.fn(async (input: { requests: ReadonlyArray<unknown> }) => {
      controller.abort();
      return input.requests.map((request, index) =>
        index === 0
          ? {
              request: request as GenomeSourceImportOutcome['request'],
              label: 'a.bw',
              family: 'data' as const,
              status: 'added' as const,
              trackId: 'track-a',
            }
          : {
              request: request as GenomeSourceImportOutcome['request'],
              label: 'b.bw',
              family: 'data' as const,
              status: 'failed' as const,
              code: 'CANCELLED' as const,
              message: 'cancelled',
            }
      );
    });
    await expect(
      execute(
        createImportGenomeSourcesTool(FOLDERS, { run: partial }),
        {
          sources: [
            { source: { kind: 'http', url: 'https://x/a.bw' } },
            { source: { kind: 'http', url: 'https://x/b.bw' } },
          ],
        },
        controller.signal
      )
    ).resolves.toMatchObject({
      ok: false,
      code: 'CANCELLED',
      stateChanged: true,
      partialEffects: ['lane:track-a'],
    });
  });
});
