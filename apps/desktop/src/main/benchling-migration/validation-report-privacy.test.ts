import { describe, expect, it } from 'vitest';

import { assertValidationReportRendererPrivacySafe } from './validation-report-privacy';

describe('validation report renderer privacy', () => {
  it('accepts a v2 report carrying the reference-outcome evidence', () => {
    expect(() =>
      assertValidationReportRendererPrivacySafe(reportWith({ providerReferences: outcomes() }))
    ).not.toThrow();
  });

  it('still refuses an unknown top-level field', () => {
    expect(() =>
      assertValidationReportRendererPrivacySafe(
        reportWith({ providerReferences: outcomes(), somethingNew: { leaked: true } })
      )
    ).toThrow();
  });

  it('refuses a main-only path smuggled inside a reference detail row', () => {
    expect(() =>
      assertValidationReportRendererPrivacySafe(
        reportWith({
          providerReferences: outcomes({
            details: [
              {
                relationshipId: 'rel_1',
                targetStableObjectId: 'seq_AAAAAA',
                objectClass: 'dna_sequence',
                outcome: 'resolved',
                title: '/Users/someone/Library/Application Support/export.zip',
                action: 'none',
              },
            ],
          }),
        })
      )
    ).toThrow();
  });
});

function outcomes(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'dnaforge.benchling.provider-reference-outcomes.v1',
    counts: { resolved: 1, pending: 0, ambiguous: 0, external: 0, source_broken: 0 },
    total: 1,
    details: [
      {
        relationshipId: 'rel_1',
        targetStableObjectId: 'seq_AAAAAA',
        objectClass: 'dna_sequence',
        outcome: 'resolved',
        title: 'pUC19 backbone',
        action: 'none',
      },
    ],
    truncated: false,
    ...overrides,
  };
}

function reportWith(extra: Record<string, unknown>): Record<string, unknown> {
  const section = { expected: 0, actual: 0, passed: true, issues: [] };
  return {
    version: 2,
    runId: 'run-1',
    scope: {
      version: 1,
      kind: 'file',
      source: { id: 'entry-1', url: 'https://benchling.com/entry-1' },
    },
    snapshotId: 'snapshot-1',
    accountHash: 'a'.repeat(64),
    generatedAt: '2026-08-20T00:00:00.000Z',
    passed: true,
    sourceObjects: section,
    attachments: section,
    memberships: section,
    relationships: { ...section, countsByClass: {} },
    projections: section,
    hashes: section,
    rendering: section,
    issues: [],
    converterVersions: { app: '0.8.0', bundle: 'b', projection: 'p' },
    exportJobs: section,
    snapshotParts: section,
    formulas: section,
    nativeConversionExceptions: [],
    collections: section,
    scopedBoundary: section,
    providerTasks: { ...section, observations: 0, jobs: 0, running: 0 },
    providerActivity: { networkRequests: 0, cacheHits: 0, countsAreExact: true },
    ...extra,
  };
}
