import { execDesignContract } from '../../../test-utils/design-output-test-helper';
import { planDesignRegionsOutputSchema } from './design-output-schemas';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { createPlanDesignRegionsTool } from './plan-design-regions';
import { sequenceResourceUri } from './get-sequence';

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

const WORKSPACE = '/home/user/lab';
const singleFolder: WorkspaceFolder[] = [{ name: 'lab', path: WORKSPACE, addedAt: 1 }];

type MockFeature = {
  displayName: string;
  type: string;
  start: number;
  end: number;
  direction: string;
};

function setupGenBankMocks(features: MockFeature[], sequenceLength = 2686) {
  mockPlatform.fs.stat.mockResolvedValue({ size: 1024 } as any);
  mockPlatform.fs.readTextFile.mockResolvedValue(
    genBankContent('source', 'A'.repeat(sequenceLength), features)
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveSequenceDocumentById.mockImplementation(async (documentId: string) => {
    if (documentId === 'missing-sequence') {
      throw new Error('The sequence source is no longer available in this project.');
    }
    return {
      documentId,
      sourcePath: `${WORKSPACE}/plasmids/source.gb`,
      ref: { kind: 'catalog-sequence', entityId: documentId },
    };
  });
});

describe('plan_design_regions tool', () => {
  it('prefers useful annotated features', async () => {
    setupGenBankMocks([
      {
        displayName: 'source',
        type: 'source',
        start: 1,
        end: 2686,
        direction: 'forward',
      },
      {
        displayName: 'AmpR promoter',
        type: 'promoter',
        start: 1179,
        end: 1283,
        direction: 'forward',
      },
      {
        displayName: 'lacZ-alpha',
        type: 'CDS',
        start: 200,
        end: 600,
        direction: 'forward',
      },
    ]);
    const tool = createPlanDesignRegionsTool(singleFolder);

    const result = await execDesignContract<{
      planned: boolean;
      documentId: string;
      resourceUri: string;
      regionCount: number;
      regions: Array<{ label: string; start: number; end: number; source: string }>;
    }>(planDesignRegionsOutputSchema, tool, { documentId: 'puc19', maxRegions: 2 });

    expect(result).toMatchObject({
      planned: true,
      documentId: 'puc19',
      resourceUri: sequenceResourceUri('puc19'),
      regionCount: 2,
      regions: [
        { label: 'AmpR promoter', start: 1179, end: 1283, source: 'feature' },
        { label: 'lacZ-alpha', start: 200, end: 600, source: 'feature' },
      ],
    });
  });

  it('returns the exact retained complement for replacing a circular-source feature', async () => {
    setupGenBankMocks(
      [
        {
          displayName: 'tac promoter',
          type: 'regulatory',
          start: 183,
          end: 211,
          direction: 'forward',
        },
        {
          displayName: 'glutathione S-transferase',
          type: 'CDS',
          start: 258,
          end: 977,
          direction: 'forward',
        },
      ],
      4969
    );
    const tool = createPlanDesignRegionsTool(singleFolder);

    const result = await execDesignContract<{
      regions: Array<{
        featureName?: string;
        replacementRetainedRange?: {
          start: number;
          end: number;
          wraps: boolean;
          length: number;
        };
      }>;
    }>(planDesignRegionsOutputSchema, tool, { documentId: 'pgex', maxRegions: 2 });

    expect(
      result.regions.find((region) => region.featureName === 'glutathione S-transferase')
        ?.replacementRetainedRange
    ).toEqual({
      start: 978,
      end: 257,
      wraps: true,
      length: 4249,
    });
  });

  it('falls back to even source windows when only whole-sequence annotations exist', async () => {
    setupGenBankMocks([
      {
        displayName: 'source',
        type: 'source',
        start: 1,
        end: 2686,
        direction: 'forward',
      },
    ]);
    const tool = createPlanDesignRegionsTool(singleFolder);

    const result = await execDesignContract<{
      planned: boolean;
      regionCount: number;
      regions: Array<{ label: string; start: number; end: number; length: number; source: string }>;
    }>(planDesignRegionsOutputSchema, tool, {
      documentId: 'l09137-design-source',
      maxRegions: 2,
      preferredRegionLength: 500,
    });

    expect(result).toMatchObject({
      planned: true,
      regionCount: 2,
      regions: [
        { label: 'Source bases 1-500', start: 1, end: 500, length: 500, source: 'window' },
        {
          label: 'Source bases 501-1000',
          start: 501,
          end: 1000,
          length: 500,
          source: 'window',
        },
      ],
    });
  });

  it('does not let fallback windows overlap selected features', async () => {
    setupGenBankMocks([
      {
        displayName: 'middle feature',
        type: 'CDS',
        start: 200,
        end: 600,
        direction: 'forward',
      },
    ]);
    const tool = createPlanDesignRegionsTool(singleFolder);

    const result = await execDesignContract<{
      planned: boolean;
      regionCount: number;
      regions: Array<{ label: string; start: number; end: number; source: string }>;
    }>(planDesignRegionsOutputSchema, tool, {
      documentId: 'puc19',
      maxRegions: 2,
      preferredRegionLength: 500,
    });

    expect(result.planned).toBe(true);
    expect(result.regionCount).toBe(2);
    const fallback = result.regions.find((region) => region.source === 'window');
    expect(fallback).toBeDefined();
    expect(fallback?.start).toBe(1);
    expect(fallback?.end).toBe(199);
  });

  it('accepts a waypoint sequence resource URI', async () => {
    setupGenBankMocks([]);
    const tool = createPlanDesignRegionsTool(singleFolder);

    const result = await execDesignContract<{ planned: boolean; documentId: string }>(
      planDesignRegionsOutputSchema,
      tool,
      {
        documentId: sequenceResourceUri('l09137'),
      }
    );

    expect(result).toMatchObject({
      planned: true,
      documentId: 'l09137',
    });
  });

  it('returns planned=false when stable identity has no source', async () => {
    const tool = createPlanDesignRegionsTool(singleFolder);

    const result = await execDesignContract<{ planned: boolean; error: string }>(
      planDesignRegionsOutputSchema,
      tool,
      {
        documentId: 'missing-sequence',
      }
    );

    expect(result.planned).toBe(false);
    expect(result.error).toContain('source is no longer available');
  });
});

function genBankContent(name: string, sequence: string, features: MockFeature[]): string {
  const featureLines = features.flatMap((feature) => {
    const location =
      feature.direction === 'reverse'
        ? `complement(${feature.start}..${feature.end})`
        : `${feature.start}..${feature.end}`;
    return [
      `     ${feature.type.padEnd(15)} ${location}`,
      `                     /label="${feature.displayName}"`,
    ];
  });
  return [
    `LOCUS       ${name.padEnd(16)} ${String(sequence.length).padStart(7)} bp    DNA     circular SYN 01-JAN-2026`,
    `DEFINITION  ${name}.`,
    'FEATURES             Location/Qualifiers',
    ...featureLines,
    'ORIGIN',
    `        1 ${sequence}`,
    '//',
  ].join('\n');
}
