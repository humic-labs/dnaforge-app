import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  compiledBroadDerivedPlanAction,
  compiledBroadPresentHasProduct,
  compiledBroadStageCommitAction,
  compiledBroadSteadyRosterPlanStatus,
  planCompiledBroadPresentRoster,
} from './indexed-compiled-broad-present';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

describe('compiled-broad present planner', () => {
  it('lives outside annotation-overlay.ts', () => {
    const source = overlaySource();
    expect(source).not.toContain('function compiledBroadPresentHasProduct');
    expect(source).not.toContain('function planCompiledBroadPresentRoster');
    expect(source).not.toContain('function compiledBroadDerivedPlanAction');
    expect(source).not.toContain('function compiledBroadStageCommitAction');
    expect(source).not.toContain('function compiledBroadSteadyRosterPlanStatus');
  });

  it('requires a requested track and at least one broad product', () => {
    const base = {
      requestedLayerCount: 1,
      hasRequirement: false,
      hasPresenter: false,
      hasCandidatePresenter: false,
      trackOwnerCount: 0,
      candidateOwnerCount: 0,
    };
    expect(compiledBroadPresentHasProduct(base)).toBe(false);
    expect(
      compiledBroadPresentHasProduct({ ...base, requestedLayerCount: 0, hasPresenter: true })
    ).toBe(false);
    expect(compiledBroadPresentHasProduct({ ...base, hasPresenter: true })).toBe(true);
    expect(compiledBroadPresentHasProduct({ ...base, trackOwnerCount: 1 })).toBe(true);
  });

  it('maps roster admission to detail, retain, or continue', () => {
    const ready = {
      hasRequirement: false,
      requirementOwnsCamera: false,
      hasLayout: true,
      anyOwnerMissing: false,
      anyGenomeOrProvenanceStale: false,
      anyCandidateRegistrationMismatch: false,
    };
    expect(planCompiledBroadPresentRoster(ready)).toEqual({ kind: 'continue' });
    expect(
      planCompiledBroadPresentRoster({
        ...ready,
        hasRequirement: true,
        requirementOwnsCamera: false,
      })
    ).toEqual({ kind: 'detail-required' });
    expect(planCompiledBroadPresentRoster({ ...ready, hasLayout: false })).toEqual({
      kind: 'retain',
      status: 'rejected',
    });
    expect(planCompiledBroadPresentRoster({ ...ready, anyOwnerMissing: true })).toEqual({
      kind: 'retain',
      status: 'broad-cells-missing',
    });
    expect(planCompiledBroadPresentRoster({ ...ready, anyGenomeOrProvenanceStale: true })).toEqual({
      kind: 'retain',
      status: 'rejected',
    });
  });

  it('maps derived and staged plan statuses onto exclusive present actions', () => {
    expect(compiledBroadDerivedPlanAction('detail-required')).toBe('detail-required');
    expect(compiledBroadDerivedPlanAction('broad-ready')).toBe('ready');
    expect(compiledBroadDerivedPlanAction('broad-artifact-required')).toBe('retain-artifact');
    expect(compiledBroadDerivedPlanAction('unknown')).toBe('retain-rejected');
    expect(compiledBroadStageCommitAction('staged')).toBe('stage');
    expect(compiledBroadStageCommitAction('already-active')).toBe('already-active');
    expect(compiledBroadStageCommitAction('missing-cells')).toBe('retain-missing');
    expect(compiledBroadStageCommitAction('failed')).toBe('retain-rejected');
    expect(compiledBroadSteadyRosterPlanStatus({ holdingLastGood: true })).toBe(
      'broad-holding-last-good'
    );
    expect(compiledBroadSteadyRosterPlanStatus({ holdingLastGood: false })).toBe(
      'broad-presenting'
    );
  });
});
