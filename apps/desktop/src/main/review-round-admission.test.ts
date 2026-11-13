// @vitest-environment node
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ReviewRoundAdmission } from './review-round-admission';
import type { ReviewRoundRequest } from '../shared/protein-experiment-workers';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'review-round-'));
  roots.push(root);
  mkdirSync(join(root, 'approvals'));
  const request: ReviewRoundRequest = {
    runId: 'round-34',
    mode: 'full-round',
    frozen: JSON.stringify({
      label: 'V34',
      sourceCommit: 'a'.repeat(40),
      instructions: 'Exact guidance',
      slots: ['a', 'b'],
    }),
    slots: ['a', 'b'],
  };
  const approve = (previousRunId: string | null = null, reviewState = 'reviewed') =>
    writeFileSync(
      join(root, 'approvals', `${request.runId}.json`),
      JSON.stringify({
        version: 1,
        request,
        previousRunId,
        reviewState,
        approvedBy: 'human',
        approvedAt: Date.now(),
        approvalText: 'Start this exact next round.',
      })
    );
  return { root, request, approve, authority: new ReviewRoundAdmission(root) };
}
describe('human advancement admission', () => {
  it('rejects direct full dispatch without a human receipt before claiming a slot', () => {
    const { authority, request } = setup();
    expect(() => authority.check(request)).toThrow(/HUMAN_REVIEW_REQUIRED/);
  });
  it('binds approval to exact frozen source, scope and instructions', () => {
    const { authority, request, approve } = setup();
    approve();
    expect(() => authority.check({ ...request, frozen: request.frozen + ' ' })).toThrow(/CHANGED/);
    expect(() => authority.check({ ...request, slots: ['a'] })).toThrow(/CHANGED/);
  });
  it('persists advancement and consumed slots across a fresh authority instance', () => {
    const { authority, request, approve, root } = setup();
    approve();
    authority.claim(request, 'a', 'job-a');
    const restarted = new ReviewRoundAdmission(root);
    expect(() => restarted.claim(request, 'a', 'another-job')).toThrow(/SLOT_ALREADY/);
    restarted.claim(request, 'b', 'job-b');
    expect(JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')).currentRunId).toBe(
      'round-34'
    );
    expect(() => restarted.check({ ...request, runId: 'round-35' })).toThrow(
      /HUMAN_REVIEW_REQUIRED/
    );
  });
  it('rejects a receipt that self-certifies or skips the current round', () => {
    const { authority, request, approve, root } = setup();
    approve();
    authority.claim(request, 'a', 'job-a');
    const next = { ...request, runId: 'round-35' };
    writeFileSync(
      join(root, 'approvals', 'round-35.json'),
      JSON.stringify({
        version: 1,
        request: next,
        previousRunId: 'round-32',
        reviewState: 'reviewed',
        approvedBy: 'agent',
        approvedAt: Date.now(),
        approvalText: 'I reviewed it.',
      })
    );
    expect(() => new ReviewRoundAdmission(root).check(next)).toThrow(/HUMAN_REVIEW_REQUIRED/);
  });
  it('permits one clearly unscored experiment but refuses a cohort disguised as one', () => {
    const { authority, request } = setup();
    expect(() => authority.check({ ...request, mode: 'experiment' })).toThrow(/ONE_OFF/);
    const experiment = { ...request, mode: 'experiment' as const, slots: ['a'] };
    authority.claim(experiment, 'a', 'exp-job');
    expect(() => authority.claim(experiment, 'a', 'exp-job-2')).toThrow(/SLOT_ALREADY/);
  });
});
