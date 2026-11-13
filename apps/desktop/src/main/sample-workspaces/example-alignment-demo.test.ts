import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { parseSidecar, sidecarToState } from '../../features/alignment-manager/store/sidecar';
import { detectPerSessionStaleness } from '../../features/alignment-manager/store/staleness';

const REL =
  'resources/sample-workspaces/standard-samples/workspace/sequences/alignments/clone-verification';
const DIR = [join(process.cwd(), REL), join(process.cwd(), 'apps/desktop', REL)].find(
  existsSync
) as string;

function genbankSequenceLength(gb: string): number {
  const originIdx = gb.indexOf('\nORIGIN');
  const body = gb.slice(originIdx + 7);
  return (body.replace(/\/\/\s*$/, '').match(/[acgtnACGTN]/g) ?? []).length;
}

describe('example workspace — clone-verification alignment demo loads (not stale)', () => {
  const refPath = join(DIR, 'reference.gb');
  const sidecarPath = join(DIR, 'reference.gb.waypoint.json');

  it('the demo files exist', () => {
    expect(existsSync(refPath), refPath).toBe(true);
    expect(existsSync(sidecarPath), sidecarPath).toBe(true);
  });

  it('the sidecar parses as AlignmentSidecar v2.0', () => {
    const sidecar = parseSidecar(readFileSync(sidecarPath, 'utf8'));
    expect(sidecar.version).toBe('2.0');
    expect(sidecar.sessions).toHaveLength(1);
    expect(sidecar.sessions[0].tracks).toHaveLength(3);
  });

  it('reference.checksum matches sha256 of the exact reference.gb text (NOT checksum-stale)', () => {
    const refText = readFileSync(refPath, 'utf8');
    const expected = `sha256:${createHash('sha256').update(refText, 'utf8').digest('hex')}`;
    const sidecar = parseSidecar(readFileSync(sidecarPath, 'utf8'));
    expect(sidecar.reference.checksum).toBe(expected);
  });

  it('no session is stale under the app’s own detectPerSessionStaleness', () => {
    const sidecar = parseSidecar(readFileSync(sidecarPath, 'utf8'));
    const { refState } = sidecarToState(sidecar, refPath);
    const refLen = genbankSequenceLength(readFileSync(refPath, 'utf8'));
    expect(refLen).toBe(900);
    const stale = detectPerSessionStaleness(refState.sessions, false, refLen);
    expect([...stale], `stale sessions: ${[...stale].join(', ')}`).toEqual([]);
  });

  it('tracks carry the expected mismatches (0 / 3 / 2) with valid aligned strings', () => {
    const sidecar = parseSidecar(readFileSync(sidecarPath, 'utf8'));
    const [t1, t2, t3] = sidecar.sessions[0].tracks;
    expect(t1.status).toBe('pass');
    expect(t1.mutations).toHaveLength(0);
    expect(t2.status).toBe('variants');
    expect(t2.mutations).toHaveLength(3);
    expect(t3.status).toBe('fail');
    expect(t3.mutations.some((m) => m.type === 'deletion' && m.length === 5)).toBe(true);
    for (const t of sidecar.sessions[0].tracks) {
      expect(t.alignment.alignedReference.length).toBe(t.alignment.alignedQuery.length);
    }
  });
});
