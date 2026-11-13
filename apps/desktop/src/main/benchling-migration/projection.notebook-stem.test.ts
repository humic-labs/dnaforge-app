import { describe, expect, it } from 'vitest';

import type { SourceObject } from '../../shared/benchling-migration';
import { buildProjectionPlan, projectionPlanPrimaryPath } from './projection';

describe('notebook package stem', () => {
  function notebook(stableId: string, name: string): SourceObject {
    return {
      id: stableId,
      stableId,
      sourceType: 'notebook_entry',
      name,
      aliases: [],
      sourceUrl: `https://benchling.com/example/${stableId}`,
      attachmentHashes: [],
      memberships: [],
      metadata: {},
      content: { html: '<html><body><p>Body</p></body></html>', attachments: [] },
      relationships: [],
    };
  }

  function packageDirectory(source: SourceObject): string {
    const plan = buildProjectionPlan(source, {
      runId: 'notebook-stem',
      capturedAt: '2026-08-20T00:00:00.000Z',
      converterVersion: 'test',
    });
    return projectionPlanPrimaryPath(plan).split('/')[1] ?? '';
  }

  const CORPUS_A = 'Controlled Corpus A — source with cross-object links';
  const CORPUS_B = 'Controlled Corpus B — linked notebook target';

  it('keeps two titles that diverge late distinguishable to a reader', () => {
    const a = packageDirectory(notebook('etr_DemoEtr001', CORPUS_A));
    const b = packageDirectory(notebook('etr_DEMOET0004', CORPUS_B));

    expect(a).not.toBe(b);

    const readable = (stem: string) =>
      stem.replace(/__[0-9a-f]{16}$/u, '').replace(/_[0-9a-f]{8}$/u, '');
    expect(readable(a)).not.toBe(readable(b));
    expect(readable(a)).toContain('Corpus_A');
    expect(readable(b)).toContain('Corpus_B');
  });

  it('converts a Benchling title that contains # into a native notebook package', () => {
    const title =
      '[ENTRY 9] Lysis and Buffer Exchange for Asparaginase Activity Assay #1 (on lysate)';
    const rootRelativePath = `ARBR Lab Notebook/${title}`;
    const plan = buildProjectionPlan(notebook('etr_DEMOET01', title), {
      runId: 'migration-hash-title',
      capturedAt: '2026-09-12T02:30:06.090Z',
      converterVersion: 'test',
      destinationEntityId: 'notebook-296ca8f528591f69a08f8b9c',
      destination: {
        kind: 'package',
        rootRelativePath,
        primaryRelativePath: `${rootRelativePath}/.forge/notebook.json`,
      },
    });

    expect(plan.projection).toBe('native');
    expect(plan.exception).toBeNull();
    expect(plan.converterId).not.toBe('benchling-artifact-card');
    expect(projectionPlanPrimaryPath(plan)).toBe(`${rootRelativePath}/.forge/notebook.json`);
  });

  it('keeps the worst-case package path inside the legacy Windows budget', () => {
    const stem = packageDirectory(notebook('etr_LONGEST', 'x'.repeat(200)));
    const worstCase = `Benchling Imports/${stem}/${stem}.benchling-provenance.json`;
    expect(worstCase.length).toBeLessThanOrEqual(180);
  });
});
